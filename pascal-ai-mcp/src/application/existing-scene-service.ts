import { t } from '../lang/i18n'
import type { SceneIntent } from '../lang/intent-vocab'
import type { WorkflowSession } from '../types'

export type ExistingSceneResult = {
  session: WorkflowSession
  reply: string
  next: 'inspect' | 'modify' | 'finish'
}

export function planExistingSceneRequest(
  session: WorkflowSession,
  message: string,
  intent: SceneIntent,
): ExistingSceneResult {
  if (intent === 'off_topic') {
    session.phase = session.sceneResult?.remainingIssueCount ? 'completed_with_issues' : 'completed'
    const reply = t(session.language, 'offTopic', {})
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }
  if (intent === 'query') {
    session.phase = 'inspecting'
    return { session, reply: t(session.language, 'inspectStarting', {}), next: 'inspect' }
  }
  if (intent === 'ambiguous') {
    session.phase = session.sceneResult?.remainingIssueCount ? 'completed_with_issues' : 'completed'
    const reply = t(session.language, 'sceneIntentAmbiguous', {})
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }

  session.pendingModification = message
  session.pendingOperation = intent
  delete session.pendingModificationMode
  delete session.pendingModificationReasonCode
  delete session.pendingModificationPlanHash
  delete session.pendingModifyPlan
  delete session.modifyModeConfirmed
  delete session.modifyDriftConfirmed
  session.phase = 'modifying'
  const reply = intent === 'create'
    ? t(session.language, 'sceneCreateStarting', { message })
    : t(session.language, 'sceneUpdateStarting', { message })
  session.messages.push({ role: 'assistant', content: reply })
  return { session, reply, next: 'modify' }
}

export async function inspectExistingScene(options: {
  session: WorkflowSession
  question: string
  loadScene: (sceneId: string) => Promise<void>
  answerQuestion: (session: WorkflowSession, question: string) => Promise<string>
  errorMessage: (error: unknown) => string
}): Promise<ExistingSceneResult> {
  const { session, question } = options
  const sceneId = session.sceneResult?.sceneId ?? session.sceneId
  if (!sceneId) {
    session.phase = 'failed'
    return { session, reply: t(session.language, 'inspectNoScene', {}), next: 'finish' }
  }
  try {
    await options.loadScene(sceneId)
    const reply = await options.answerQuestion(session, question)
    session.phase = session.sceneResult?.remainingIssueCount ? 'completed_with_issues' : 'completed'
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  } catch (error) {
    session.phase = 'completed_with_issues'
    const reply = t(session.language, 'inspectFailed', { error: options.errorMessage(error) })
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }
}
