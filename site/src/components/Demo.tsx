import { useEffect, useRef, type ReactNode } from "react";

declare global {
  interface Window {
    lottie?: { loadAnimation: (opts: Record<string, unknown>) => { play(): void; pause(): void } };
  }
}

/** Screenshot (or terminal) fallback that upgrades to a looping Lottie demo when the vendored player is present. */
export function Demo({ demo, children }: { demo: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let observer: IntersectionObserver | undefined;
    const start = async () => {
      if (!window.lottie) return;
      try {
        const data = await (await fetch(demo)).json();
        if (cancelled) return;
        const anim = document.createElement("div");
        anim.className = "anim";
        anim.setAttribute("aria-hidden", "true");
        el.append(anim);
        const player = window.lottie.loadAnimation({ container: anim, renderer: "svg", loop: true, autoplay: false, animationData: data });
        el.classList.add("playing");
        // four looping demos at once is a CPU hog; only the visible one plays
        observer = new IntersectionObserver(([entry]) => (entry.isIntersecting ? player.play() : player.pause()), { rootMargin: "80px 0px" });
        observer.observe(el);
      } catch (error) {
        console.warn("lottie demo failed, keeping screenshot", error);
      }
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => { cancelled = true; observer?.disconnect(); };
  }, [demo]);
  return <div ref={frame} className="frame demo">{children}</div>;
}
