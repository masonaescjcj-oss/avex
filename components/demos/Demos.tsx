'use client';

import { useInView, useReducedMotion, useSteps } from '@/lib/hooks';
import s from './Demos.module.css';

type ShellProps = {
  label: string;
  children: React.ReactNode;
  status: string;
  statusOn: boolean;
};

function Shell({ label, children, status, statusOn }: ShellProps) {
  return (
    <>
      <div className={s.bar}>
        <span className={s.pips} aria-hidden="true">
          <span className={s.pip} />
          <span className={s.pip} />
          <span className={s.pip} />
        </span>
        <span className={s.label}>{label}</span>
      </div>
      <div className={s.body}>
        {children}
        <p className={s.foot} data-on={statusOn ? '1' : '0'}>
          <span className="dot" aria-hidden="true" />
          {status}
        </p>
      </div>
    </>
  );
}

/* ---------------- 01 · Website Development ---------------- */

const URL = 'retroai.agency';
const VITALS = [
  { name: 'Perf', score: 99 },
  { name: 'A11y', score: 100 },
  { name: 'SEO', score: 100 },
];

function BrowserDemo() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const reduced = useReducedMotion();
  // 1–14 type the URL, then paint four blocks, then three vitals.
  const step = useSteps(inView, 14 + 4 + 3, 150, reduced);

  const typed = Math.min(URL.length, Math.max(0, Math.round((step / 14) * URL.length)));
  const painted = Math.max(0, step - 14);
  const vitals = Math.max(0, step - 18);

  return (
    <div className={s.win} ref={ref}>
      <Shell label="web · build" status="Deployed · LCP 0.9 s" statusOn={vitals >= 3}>
        <div className={s.urlBar}>
          <span className={s.lock} aria-hidden="true">
            ▲
          </span>
          <span>
            {URL.slice(0, typed)}
            {typed < URL.length && <i className={s.caret} aria-hidden="true" />}
          </span>
        </div>

        <div className={s.paint} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={s.skel} data-on={painted > i ? '1' : '0'} />
          ))}
        </div>

        <div className={s.vitals}>
          {VITALS.map((v, i) => (
            <div
              className={s.vital}
              key={v.name}
              data-on={vitals > i ? '1' : '0'}
              style={{ '--w': `${v.score}%` } as React.CSSProperties}
            >
              <span className={s.vitalName}>{v.name}</span>
              <span className={s.vitalTrack}>
                <span className={s.vitalFill} />
              </span>
              <span className={s.vitalScore}>{vitals > i ? v.score : '—'}</span>
            </div>
          ))}
        </div>
      </Shell>
    </div>
  );
}

/* ---------------- 02 · Application Development ---------------- */

const PIPELINE = [
  { name: 'build', meta: '212 modules' },
  { name: 'test', meta: '1,284 passed' },
  { name: 'migrate', meta: '41 applied' },
  { name: 'deploy → api-01', meta: 'p95 118 ms' },
];

function DeployDemo() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const reduced = useReducedMotion();
  const step = useSteps(inView, PIPELINE.length, 700, reduced);

  return (
    <div className={s.win} ref={ref}>
      <Shell label="app · ci/cd" status="Live · v2.14.0 · all green" statusOn={step >= PIPELINE.length}>
        {PIPELINE.map((p, i) => (
          <div className={s.step} key={p.name} data-on={step > i ? '1' : '0'}>
            <div className={s.stepTop}>
              <span className={s.stepMark}>{step > i ? '✓' : '·'}</span>
              <span className={s.stepName}>{p.name}</span>
              <span className={s.stepMeta}>{step > i ? p.meta : 'queued'}</span>
            </div>
            <span className={s.track}>
              <span className={s.fill} />
            </span>
          </div>
        ))}
      </Shell>
    </div>
  );
}

/* ---------------- 03 · Automation ---------------- */

const DOCS = [
  { id: 'INV-4021', amt: '€1,240.00', flag: false },
  { id: 'INV-4022', amt: '€380.50', flag: false },
  { id: 'INV-4023', amt: '€92.00', flag: true },
  { id: 'INV-4024', amt: '€7,715.00', flag: false },
];

function IntakeDemo() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const reduced = useReducedMotion();
  const step = useSteps(inView, DOCS.length + 1, 520, reduced);

  return (
    <div className={s.win} ref={ref}>
      <Shell
        label="intake.xlsx → clean"
        status="312 docs/hr · 0 errors"
        statusOn={step > DOCS.length}
      >
        {DOCS.map((d, i) => (
          <div
            className={`${s.rowDoc} ${s.in}`}
            key={d.id}
            data-on={step > i ? '1' : '0'}
            data-flag={d.flag ? '1' : '0'}
          >
            <span className={s.rowId}>{d.id}</span>
            <span className={s.rowAmt}>· {d.amt}</span>
            <span className={s.rowMark}>
              {d.flag ? '→ review queue' : '✓'}
            </span>
          </div>
        ))}
        <p className={`${s.validated} ${s.in}`} data-on={step > DOCS.length ? '1' : '0'}>
          Validated · 3 posted · 1 flagged
        </p>
      </Shell>
    </div>
  );
}

/* ---------------- 04 · AI Development ---------------- */

const TOOLS = ['policy.lookup', 'orders.get', 'refund.create'];

function AgentDemo() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const reduced = useReducedMotion();
  // question → typing → answer → tools → status
  const step = useSteps(inView, 4, 900, reduced);

  return (
    <div className={s.win} ref={ref}>
      <Shell label="agent · support triage" status="Resolved · no human in loop" statusOn={step >= 4}>
        <p className={`${s.bubble} ${s.bubbleUser} ${s.in}`} data-on={step > 0 ? '1' : '0'}>
          Order #8842 arrived damaged. Can I get a refund?
        </p>

        {step === 1 && (
          <span className={s.typing} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}

        <p className={`${s.bubble} ${s.bubbleBot} ${s.in}`} data-on={step > 1 ? '1' : '0'}>
          Policy allows it — order is 6 days old. Refund of €128.00 issued to your card and a
          replacement is on the way.
        </p>

        <div className={s.tools}>
          {TOOLS.map((t, i) => (
            <span className={`${s.tool} ${s.in}`} key={t} data-on={step > 2 ? '1' : '0'}
              style={{ transitionDelay: `${i * 90}ms` }}>
              {t}
            </span>
          ))}
        </div>
      </Shell>
    </div>
  );
}

/* ---------------- dispatcher ---------------- */

export type DemoKind = 'browser' | 'deploy' | 'intake' | 'agent';

const DEMOS: Record<DemoKind, () => React.JSX.Element> = {
  browser: BrowserDemo,
  deploy: DeployDemo,
  intake: IntakeDemo,
  agent: AgentDemo,
};

export default function Demo({ kind }: { kind: DemoKind }) {
  const Component = DEMOS[kind];
  return <Component />;
}
