import { useEffect, type ReactNode } from "react";

/** Adds `html.js` and fades `.reveal` blocks in as they scroll into view (port of the original inline script). */
export function useReveal() {
  useEffect(() => {
    document.documentElement.classList.add("js");
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("in"); observer.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -60px 0px" });
    const els = document.querySelectorAll(".reveal");
    els.forEach((el) => observer.observe(el));
    const t = setTimeout(() => els.forEach((el) => el.classList.add("in")), 1200);
    return () => { observer.disconnect(); clearTimeout(t); };
  }, []);
}

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={className}>
      <div className="sec reveal">{children}</div>
    </section>
  );
}
