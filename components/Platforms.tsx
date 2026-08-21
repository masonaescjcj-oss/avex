import { platforms } from '@/lib/content';
import Reveal from './Reveal';
import s from './Platforms.module.css';

const count = platforms.reduce((total, group) => total + group.items.length, 0);

export default function Platforms() {
  return (
    <>
      <div className={s.grid}>
        {platforms.map((group, i) => (
          <Reveal key={group.label} className={s.group} delay={i * 50}>
            <div className={s.groupHead}>
              <span className={s.groupLabel}>{group.label}</span>
              <span className={s.groupNote}>{group.note}</span>
            </div>
            <div className={s.items}>
              {group.items.map((item) => (
                <span className={s.item} key={item}>
                  {item}
                </span>
              ))}
            </div>
          </Reveal>
        ))}
      </div>
      <p className={s.disclaimer}>
        {count} systems we build on and integrate with. These are the tools and platforms we work
        in — not a client list.
      </p>
    </>
  );
}
