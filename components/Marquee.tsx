import styles from './Marquee.module.css';

export default function Marquee({
  items,
  duration = 42,
}: {
  items: readonly string[];
  duration?: number;
}) {
  // Duplicated so the -50% keyframe loops seamlessly.
  const doubled = [...items, ...items];

  return (
    <div className={styles.strip} aria-hidden="true">
      <div className={styles.track} style={{ '--dur': `${duration}s` } as React.CSSProperties}>
        {doubled.map((item, i) => (
          <span className={styles.item} key={`${item}-${i}`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
