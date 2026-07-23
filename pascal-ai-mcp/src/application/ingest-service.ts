import { t } from '../lang/i18n'
import type { ChatInput, DesignBrief, RequirementFact, WorkflowSession } from '../types'

export type IngestPlan =
  | { kind: 'reply'; reply: string }
  | { kind: 'route'; reply: string; next: 'generate' | 'modify' }
  | { kind: 'route-existing'; message: string }
  | { kind: 'intake'; message: string }

export function shouldRouteAsExistingSceneRequest(
  phase: WorkflowSession['phase'],
  message: string,
): boolean {
  return phase === 'awaiting_modification_confirmation' && message.trim().length > 0
}

export function planIngestAction(input: ChatInput, session: WorkflowSession): IngestPlan {
  if (input.action === 'cancel') {
    session.phase = 'cancelled'
    session.questions = []
    return { kind: 'reply', reply: t(session.language, 'taskCancelled', {}) }
  }

  if (input.action === 'confirm') {
    if (session.phase === 'awaiting_modification_confirmation' && session.pendingModification) {
      if (session.pendingModificationMode === 'plan_rebuild') {
        session.modifyModeConfirmed = true
      }
      session.phase = 'modifying'
      return { kind: 'route', reply: t(session.language, 'modifyConfirmed', {}), next: 'modify' }
    }
    if (session.phase !== 'awaiting_confirmation' && session.phase !== 'clarifying') {
      return { kind: 'reply', reply: t(session.language, 'notReadyToConfirm', {}) }
    }
    const acceptedDefaults = session.phase === 'clarifying'
    session.confirmedAt = new Date().toISOString()
    session.phase = 'generating'
    session.brief = confirmBrief(session.brief)
    return {
      kind: 'route',
      reply: acceptedDefaults
        ? t(session.language, 'confirmedWithDefaults', {})
        : t(session.language, 'requirementsConfirmed', {}),
      next: 'generate',
    }
  }

  const message = input.message?.trim() ?? ''
  if (!message && !input.imageDataUrl) {
    return { kind: 'reply', reply: t(session.language, 'emptyInput', {}) }
  }
  if (shouldRouteAsExistingSceneRequest(session.phase, message)) {
    delete session.pendingModification
    delete session.pendingOperation
    delete session.pendingModificationMode
    delete session.pendingModificationReasonCode
    delete session.pendingModificationPlanHash
    delete session.modifyModeConfirmed
    delete session.modifyDriftConfirmed
    return { kind: 'route-existing', message }
  }
  if (session.phase === 'completed' || session.phase === 'completed_with_issues') {
    if (!message) {
      return { kind: 'reply', reply: t(session.language, 'describeChangesInText', {}) }
    }
    return { kind: 'route-existing', message }
  }
  if (message.length > 5000) {
    return { kind: 'reply', reply: t(session.language, 'messageTooLong', {}) }
  }
  if (input.imageDataUrl && !isSupportedImage(input.imageDataUrl)) {
    session.phase = 'failed'
    session.availability = 'unusable'
    return { kind: 'reply', reply: t(session.language, 'unsupportedImage', {}) }
  }
  return { kind: 'intake', message }
}

function confirmBrief(brief: DesignBrief): DesignBrief {
  const confirm = (facts: RequirementFact[]) => facts.map(fact => ({
    ...fact,
    confirmationStatus: 'confirmed' as const,
  }))
  return {
    ...brief,
    existingCondition: confirm(brief.existingCondition),
    designGoals: confirm(brief.designGoals),
    hardConstraints: confirm(brief.hardConstraints),
    assumptions: confirm(brief.assumptions),
    uncertainties: [],
    conflicts: [],
  }
}

function isSupportedImage(dataUrl: string): boolean {
  const match = dataUrl.match(/^data:image\/(png|jpe?g);base64,([a-z0-9+/=]+)$/i)
  if (!match) return false
  return (match[2]?.length ?? Number.POSITIVE_INFINITY) <= 28 * 1024 * 1024
}
