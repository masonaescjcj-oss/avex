'use client';

import { useEffect, useState } from 'react';

/** Live UTC clock. Renders a placeholder until mounted to keep SSR output stable. */
export default function Clock({ label = 'UTC' }: { label?: string }) {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(
        [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
          .map((n) => String(n).padStart(2, '0'))
          .join(':'),
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span className="mono" suppressHydrationWarning>
      {time ?? '--:--:--'} {label}
    </span>
  );
}
