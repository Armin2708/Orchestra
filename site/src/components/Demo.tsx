import { useEffect, useRef, type ReactNode } from "react";

declare global {
  interface Window {
    lottie?: { loadAnimation: (opts: Record<string, unknown>) => unknown };
  }
}

/** Screenshot (or terminal) fallback that upgrades to a looping Lottie demo when the vendored player is present. */
export function Demo({ demo, children }: { demo: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    const start = async () => {
      if (!window.lottie) return;
      try {
        const data = await (await fetch(demo)).json();
        if (cancelled) return;
        const anim = document.createElement("div");
        anim.className = "anim";
        anim.setAttribute("aria-hidden", "true");
        el.append(anim);
        window.lottie.loadAnimation({ container: anim, renderer: "svg", loop: true, autoplay: true, animationData: data });
        el.classList.add("playing");
      } catch (error) {
        console.warn("lottie demo failed, keeping screenshot", error);
      }
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => { cancelled = true; };
  }, [demo]);
  return <div ref={frame} className="frame demo">{children}</div>;
}
