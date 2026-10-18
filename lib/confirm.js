/**
 * The only user-approval channel this plugin trusts.
 *
 * `ctx.approval` is unusable here: the profile runs with the `danger-full-access`
 * preset, whose approval policy is `never`, so every request returns `rejected`
 * before a human ever sees it. `ctx.userQuestions` is a different mechanism —
 * it renders a real card in the Web UI and resolves only when the user clicks.
 *
 * Nothing in this module can be driven from a tool argument: the question text,
 * the options and the approve label are constants, and the returned answer is
 * produced by the host's answerer chain, not by the model.
 * @module af/confirm
 */
import { AfError, CODE } from './errors.js'

export const APPROVE_LABEL = 'Approve plan'
export const REJECT_LABEL = 'Request changes'
export const QUESTION_ID = 'af-plan-review'

/**
 * Ask the user to approve one specific plan.
 *
 * @param {{get: (name: string) => any}} ctx Cordis context
 * @param {{planId: number, digest: string, markdown: string, agent?: object, signal?: AbortSignal}} input
 * @returns {Promise<{approved: boolean, reason: string}>}
 */
export async function requestPlanApproval(ctx, input) {
  let service = null
  try {
    service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : null
  } catch {
    service = null
  }
  if (!service || typeof service.ask !== 'function') {
    throw new AfError(
      CODE.APPROVAL_UNAVAILABLE,
      'no userQuestions service is mounted, so no verifiable approval channel exists',
    )
  }

  let answer
  try {
    answer = await service.ask({
      questions: [
        {
          id: QUESTION_ID,
          header: 'File plan review',
          question: `Approve file plan #${input.planId}?`,
          detail: input.markdown,
          options: [
            { label: APPROVE_LABEL, description: 'Move the listed duplicates into the quarantine directory' },
            { label: REJECT_LABEL, description: 'Do nothing; edit the plan and propose again' },
          ],
          intent: { kind: 'plan-review', approve: APPROVE_LABEL },
        },
      ],
      agent: input.agent,
      signal: input.signal,
    })
  } catch (error) {
    // The host signals "user closed / requested changes" with ASK_CANCELLED.
    if (error?.code === 'ASK_CANCELLED' || error?.name === 'UserQuestionError') {
      return { approved: false, reason: 'cancelled' }
    }
    throw error
  }

  const answers = Array.isArray(answer?.answers) ? answer.answers : Array.isArray(answer) ? answer : []
  const first = answers.find((entry) => entry?.id === QUESTION_ID) ?? answers[0]
  const selected = Array.isArray(first?.selected) ? first.selected : []
  const custom = typeof first?.custom === 'string' ? first.custom.trim() : ''

  // Exactly one selected option, exactly the approve label, and no free-text
  // alternative. Anything else is not an approval.
  if (selected.length === 1 && selected[0] === APPROVE_LABEL && custom === '') {
    return { approved: true, reason: 'approved' }
  }
  return { approved: false, reason: custom !== '' ? `custom:${custom.slice(0, 120)}` : 'not-approved' }
}
