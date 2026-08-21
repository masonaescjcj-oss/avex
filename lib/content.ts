export type PlatformGroup = { label: string; note: string; items: string[] };

/**
 * Systems we build on and integrate with. These are tools, not clients — the
 * distinction matters and the section on the site states it plainly.
 */
export const platforms: PlatformGroup[] = [
  {
    label: 'Commerce & payments',
    note: 'Checkout, subscriptions, invoicing',
    items: ['Stripe', 'Shopify', 'WooCommerce', 'PayPal', 'Paddle'],
  },
  {
    label: 'CRM & support',
    note: 'Pipelines, tickets, customer data',
    items: ['Salesforce', 'HubSpot', 'Zendesk', 'Intercom', 'Pipedrive'],
  },
  {
    label: 'AI & retrieval',
    note: 'Models, embeddings, vector search',
    items: ['OpenAI', 'Anthropic', 'Hugging Face', 'Pinecone', 'LangChain'],
  },
  {
    label: 'Cloud & data',
    note: 'Hosting, databases, caching',
    items: ['AWS', 'Google Cloud', 'Vercel', 'Supabase', 'PostgreSQL', 'Redis'],
  },
  {
    label: 'Automation',
    note: 'Pipelines between the tools you own',
    items: ['n8n', 'Zapier', 'Make', 'Airtable', 'Google Sheets'],
  },
  {
    label: 'Comms & content',
    note: 'Messaging, notifications, publishing',
    items: ['Telegram', 'WhatsApp Business', 'Twilio', 'Slack', 'Notion', 'WordPress'],
  },
];

export type Post = {
  slug: string;
  title: string;
  date: string;
  readingTime: string;
  category: string;
  excerpt: string;
  body: string[];
};

export const posts: Post[] = [
  {
    slug: 'evals-before-prompts',
    title: 'Write the eval before you write the prompt',
    date: '2026-07-28',
    readingTime: '6 min',
    category: 'AI Development',
    excerpt:
      'Every AI feature that quietly rotted in production had the same origin story: a great demo and no way to tell whether it still worked on Tuesday.',
    body: [
      'A demo proves a thing can happen once. An eval proves it keeps happening. The gap between those two sentences is where most AI projects die, usually two months after the launch announcement, when nobody can say whether the output got worse or the users got pickier.',
      'So we invert the order. Before a prompt is written, we collect thirty to fifty real cases from the client — the actual messy inputs, including the ones that made someone escalate to a manager. Each case gets an expected outcome, graded by whoever owns the process today. That set becomes the contract.',
      'Once the harness exists, prompt work stops being taste and starts being measurement. You change one instruction, you re-run, you see 0.81 become 0.88, and you keep it. You see it become 0.74, and you throw it away without arguing about it in a meeting.',
      'The second benefit is slower and more valuable: the eval set is the only artefact that survives a model change. When the underlying model is swapped for something cheaper or newer, the set tells you in ten minutes whether the swap was safe. Without it, you are shipping a rumour.',
    ],
  },
  {
    slug: 'automation-audit',
    title: 'The automation audit: find the hours before you write the code',
    date: '2026-06-14',
    readingTime: '5 min',
    category: 'Automation',
    excerpt:
      'Most teams ask us to automate the loudest process. The loudest is rarely the most expensive one.',
    body: [
      'The first week of an automation engagement contains no code. We sit with the people doing the work and count: how many times a day, how many minutes each time, how often it goes wrong, and what happens downstream when it does.',
      'The result is usually surprising. The task everyone complains about costs eleven hours a month. The task nobody mentions — copying figures between two systems because the integration was never finished — costs ninety.',
      'We rank candidates by hours saved divided by build complexity, then automate top-down. That ordering matters more than the tooling. A crude script against the right process beats an elegant pipeline against the wrong one.',
      'One rule we do not break: every automated step keeps an audit trail and a human override. Automation that cannot be inspected is not a time saving, it is a liability with better latency.',
    ],
  },
  {
    slug: 'shipping-on-vercel',
    title: 'What a fast site actually costs',
    date: '2026-05-02',
    readingTime: '4 min',
    category: 'Website Development',
    excerpt:
      'Performance is not a plugin. It is a series of small refusals — to the extra font, the tracking script, the carousel nobody asked for.',
    body: [
      'A 99 Lighthouse score is not won at the end of a project. It is won every time someone suggests adding a third-party widget and the answer is a measured no.',
      'Our baseline: server-render everything that can be static, ship one font family with two weights, keep shared JS under 100 kB, and hold third-party scripts to a documented list with an owner for each one.',
      'The interesting constraint is editorial, not technical. A design that needs four typefaces and a video header will never be fast, no matter how good the framework is. So performance enters the conversation during design review, when it is still cheap to change.',
      'The payoff is boring and large: pages that work on a mid-range phone on a bad connection, which is what most of your traffic actually is.',
    ],
  },
  {
    slug: 'agents-with-guardrails',
    title: 'Give the agent tools, then take some away',
    date: '2026-03-19',
    readingTime: '7 min',
    category: 'AI Development',
    excerpt:
      'An agent with ten tools and no boundaries is a very expensive way to generate incidents. Scope is the feature.',
    body: [
      'The instinct when building an agent is to hand it everything: the database, the email client, the payment API. It feels powerful. It is also how you end up explaining a refund loop to a finance director.',
      'We scope agents the way we scope service accounts. Each tool has an explicit permission, a rate limit and a maximum blast radius. Anything irreversible — money moving, data deleted, a message sent to a customer — passes through a confirmation step or a queue a human drains.',
      'Then we log every call. Not the summary, the actual arguments and results, retained long enough to reconstruct any decision after the fact. When something odd happens, the question "what did it do" should take thirty seconds to answer.',
      'Counter-intuitively, the tighter the scope, the better the agent performs. Fewer tools means fewer wrong turns, shorter context and cheaper runs. Capability you remove is usually accuracy you gain.',
    ],
  },
];

export type Role = {
  title: string;
  type: string;
  location: string;
  summary: string;
  stack: string[];
};

export const roles: Role[] = [
  {
    title: 'Senior Full-Stack Engineer',
    type: 'Full-time',
    location: 'Remote',
    summary:
      'Own features end-to-end across Next.js and Postgres, from data model to the deploy that ships it.',
    stack: ['TypeScript', 'Next.js', 'Postgres', 'AWS / Vercel'],
  },
  {
    title: 'AI Engineer',
    type: 'Full-time',
    location: 'Remote',
    summary:
      'Build retrieval systems, agents and eval harnesses for clients in production, not in notebooks.',
    stack: ['Python', 'LLM APIs', 'Vector search', 'Evals'],
  },
  {
    title: 'Automation Engineer',
    type: 'Contract',
    location: 'Remote',
    summary:
      'Map a client process in a week, replace it in three. Integrations, queues, audit logs, retries.',
    stack: ['Node / Python', 'n8n', 'REST & webhooks', 'Postgres'],
  },
  {
    title: 'Product Designer',
    type: 'Part-time',
    location: 'Remote',
    summary:
      'Interface design for dense, operational software — dashboards, queues and admin tools people use all day.',
    stack: ['Figma', 'Design systems', 'Prototyping', 'Motion'],
  },
];

export type ProcessStep = {
  index: string;
  title: string;
  duration: string;
  body: string;
  outputs: string[];
};

export const processSteps: ProcessStep[] = [
  {
    index: '01',
    title: 'Scope',
    duration: 'Week 1',
    body:
      'We interrogate the problem before the solution. What breaks today, who feels it, what a fix is worth. You leave this phase with a written scope and a number, not a vibe.',
    outputs: ['Written scope', 'Success metrics', 'Fixed-price estimate'],
  },
  {
    index: '02',
    title: 'Architect',
    duration: 'Week 2',
    body:
      'Data model, integrations, failure modes and the boring decisions that are expensive to reverse. For AI work, the eval set is built here.',
    outputs: ['System diagram', 'Data model', 'Eval harness'],
  },
  {
    index: '03',
    title: 'Build',
    duration: 'Weeks 3–8',
    body:
      'Weekly demos against a staging environment you can click. No dark period, no big reveal. If a decision needs you, you hear about it that week.',
    outputs: ['Staging environment', 'Weekly demo', 'Test suite'],
  },
  {
    index: '04',
    title: 'Ship',
    duration: 'Launch week',
    body:
      'Production deploy, monitoring, alerting and a runbook written for your team. Then we watch the graphs with you for the first fortnight.',
    outputs: ['Production deploy', 'Monitoring & alerts', 'Runbook'],
  },
  {
    index: '05',
    title: 'Operate',
    duration: 'Ongoing',
    body:
      'Optional. We keep the thing running — patches, model swaps, cost tuning and the next set of features, on a monthly retainer.',
    outputs: ['SLA & on-call', 'Monthly report', 'Roadmap reviews'],
  },
];

export type Fleet = { name: string; region: string; state: 'OPERATIONAL' | 'DEGRADED'; uptime: string; latency: string };

export const fleet: Fleet[] = [
  { name: 'Web edge', region: 'Global CDN', state: 'OPERATIONAL', uptime: '99.99%', latency: '38 ms' },
  { name: 'Application API', region: 'eu-central', state: 'OPERATIONAL', uptime: '99.97%', latency: '118 ms' },
  { name: 'Automation workers', region: 'eu-central', state: 'OPERATIONAL', uptime: '99.95%', latency: '204 ms' },
  { name: 'AI gateway', region: 'multi-region', state: 'OPERATIONAL', uptime: '99.93%', latency: '640 ms' },
  { name: 'Postgres cluster', region: 'eu-central', state: 'OPERATIONAL', uptime: '99.99%', latency: '9 ms' },
  { name: 'Object storage', region: 'multi-region', state: 'OPERATIONAL', uptime: '100%', latency: '52 ms' },
];
