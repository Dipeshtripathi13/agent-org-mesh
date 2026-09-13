/** The "Get started" checklist on My agent — every step's done-state is derived from real data,
 *  never a click on the checklist itself. */

export interface GettingStartedInput {
  /** The org's answering agent has been chosen. */
  hasAnsweringAgent: boolean;
  /** This person can change org settings (owner or admin of this org). */
  isOrgAdmin: boolean;
  connectedTools: number;
  askedQuestions: number;
  peopleInOrg: number;
}

export interface Step {
  key: 'agent' | 'tool' | 'ask' | 'team';
  title: string;
  detail: string;
  done: boolean;
  action: { label: string; path: string } | null;
}

export function gettingStartedSteps(input: GettingStartedInput): Step[] {
  const steps: Step[] = [
    {
      key: 'agent',
      title: 'Choose the AI that answers',
      detail: input.hasAnsweringAgent
        ? 'Your organization’s agent is set.'
        : input.isOrgAdmin
          ? 'Pick Claude, ChatGPT or your own model. It’s shared by everyone in your organization.'
          : 'An admin of your organization chooses this for everyone. Nothing can answer until they do.',
      done: input.hasAnsweringAgent,
      action: !input.hasAnsweringAgent && input.isOrgAdmin ? { label: 'Choose one', path: '/admin/organizations' } : null,
    },
    {
      key: 'tool',
      title: 'Connect a tool you work in',
      detail: input.connectedTools > 0
        ? `${input.connectedTools === 1 ? '1 tool' : `${input.connectedTools} tools`} connected.`
        : 'GitHub, Jira, Linear, Notion and more. Your agent only ever reads — it never changes anything.',
      done: input.connectedTools > 0,
      action: input.connectedTools > 0 ? null : { label: 'Connect a tool', path: '/me/setup' },
    },
    {
      key: 'ask',
      title: 'Ask your first question',
      detail: input.askedQuestions > 0
        ? 'Done. Your chats are listed on the left of the chat box.'
        : 'Try “What have I been working on this week?” in the chat box on this page.',
      done: input.askedQuestions > 0,
      action: null,
    },
  ];
  if (input.isOrgAdmin) {
    steps.push({
      key: 'team',
      title: 'Add your team',
      detail: input.peopleInOrg > 1
        ? `${input.peopleInOrg} people in your organization.`
        : 'Add people and who they report to, so they can ask each other’s agents for updates.',
      done: input.peopleInOrg > 1,
      action: input.peopleInOrg > 1 ? null : { label: 'Add people', path: '/admin/organizations' },
    });
  }
  return steps;
}

export function progressLabel(steps: Step[]): string {
  const done = steps.filter((s) => s.done).length;
  return `${done} of ${steps.length} done`;
}
