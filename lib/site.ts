export const site = {
  name: 'RetroAI',
  legal: 'RetroAI Agency',
  domain: 'retroai.agency',
  url: 'https://retroai.agency',
  tagline: 'Website · Application · Automation · AI Development',
  description:
    'RetroAI is a product studio building websites, applications, automation pipelines and AI systems. We design, build and operate software that runs itself.',
  founded: 2021,
  contact: {
    email: 'info@retroai.agency',
    telegram: 'https://t.me/isaacar',
    telegramHandle: '@isaacar',
    channel: 'https://t.me/retroagency',
    channelHandle: '@retroagency',
  },
  locations: ['Remote-first', 'Worldwide delivery'],
} as const;

export type NavItem = { label: string; href: string; index: string; note: string };

export const nav: NavItem[] = [
  { label: 'Home', href: '/', index: '01', note: 'the studio' },
  { label: 'Services', href: '/services', index: '02', note: 'what we build' },
  { label: 'Process', href: '/process', index: '03', note: 'how we run' },
  { label: 'About', href: '/about', index: '04', note: 'who we are' },
  { label: 'Journal', href: '/blog', index: '05', note: 'notes & builds' },
  { label: 'Careers', href: '/careers', index: '06', note: 'open roles' },
  { label: 'Contact', href: '/contact', index: '07', note: 'start a project' },
];

export type Service = {
  id: string;
  slug: string;
  index: string;
  title: string;
  lede: string;
  body: string;
  tags: string[];
  deliverables: string[];
  demo: 'browser' | 'deploy' | 'intake' | 'agent';
};

export const services: Service[] = [
  {
    id: 'web',
    slug: 'website-development',
    index: '01',
    title: 'Website Development',
    lede: 'Sites that load fast, rank well and convert.',
    body:
      'Marketing sites, landing pages, e-commerce and content platforms built on Next.js. Server-rendered, accessible, measured against real Core Web Vitals — not a template with your logo dropped in.',
    tags: ['Next.js', 'Design systems', 'SEO', 'Headless CMS'],
    deliverables: [
      'Design system and component library',
      'Server-rendered pages, edge caching',
      'CMS your team can actually use',
      'Analytics, SEO and schema wired in',
    ],
    demo: 'browser',
  },
  {
    id: 'app',
    slug: 'application-development',
    index: '02',
    title: 'Application Development',
    lede: 'Products with users, billing and a real backend.',
    body:
      'Web and mobile applications from first prototype to production scale. Auth, payments, dashboards, multi-tenant data models, background jobs — the unglamorous parts that decide whether a product survives.',
    tags: ['SaaS', 'Mobile', 'API design', 'Postgres'],
    deliverables: [
      'Architecture and data modelling',
      'Auth, roles, billing and webhooks',
      'Admin and operator tooling',
      'CI/CD, monitoring, on-call runbooks',
    ],
    demo: 'deploy',
  },
  {
    id: 'automation',
    slug: 'automation',
    index: '03',
    title: 'Automation',
    lede: 'The manual work, quietly removed.',
    body:
      'We map the process your team repeats every day, then replace it. Document intake, spreadsheet operations, reconciliation, CRM hygiene, reporting — wired between the tools you already pay for.',
    tags: ['Document AI', 'Workflows', 'Integrations', 'RPA'],
    deliverables: [
      'Process audit with hours-saved model',
      'Pipelines with retries and audit logs',
      'Integrations across your existing stack',
      'Human-in-the-loop review where it matters',
    ],
    demo: 'intake',
  },
  {
    id: 'ai',
    slug: 'ai-development',
    index: '04',
    title: 'AI Development',
    lede: 'Agents and models doing measurable work.',
    body:
      'LLM applications, retrieval systems, agents that call your tools and voice interfaces. We start from the task and the eval, not the demo — so what ships keeps working after the launch tweet.',
    tags: ['LLM apps', 'RAG', 'Agents', 'Evals'],
    deliverables: [
      'Eval harness before a line of prompt',
      'Retrieval over your own knowledge base',
      'Tool-calling agents with guardrails',
      'Cost, latency and quality dashboards',
    ],
    demo: 'agent',
  },
];

export type Stat = { label: string; value: string; note?: string };

export const stats: Stat[] = [
  { label: 'Projects shipped', value: '60+', note: 'since 2021' },
  { label: 'Automations running', value: '120+', note: 'in production' },
  { label: 'Countries served', value: '14', note: 'across 5 regions' },
  { label: 'Avg. uptime', value: '99.9%', note: 'trailing 12 months' },
];

export const stack: string[] = [
  'NEXT.JS',
  'REACT',
  'TYPESCRIPT',
  'NODE',
  'PYTHON',
  'POSTGRES',
  'REDIS',
  'LLM ORCHESTRATION',
  'RAG',
  'AGENTS',
  'N8N',
  'DOCKER',
  'VERCEL',
  'SUPABASE',
  'STRIPE',
  'TAILWIND',
  'REACT NATIVE',
  'PLAYWRIGHT',
];
