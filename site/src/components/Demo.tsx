import { useEffect, useRef, type ReactNode } from "react";

type LottiePlayer = { play(): void; pause(): void; destroy(): void };
declare global {
  interface Window {
    lottie?: { loadAnimation: (opts: Record<string, unknown>) => LottiePlayer };
  }
}

/**
 * Screenshot (or terminal) fallback that upgrades to a looping Lottie demo while it is
 * near the viewport. The player is mounted on approach and destroyed on exit on purpose:
 * Chromium re-paints everything within ~4000px of the viewport whenever the hero strings
 * animate, and four idle Lottie SVGs (hundreds of paths, masks) there made the hero drop
 * whole frames. With no Lottie DOM near the hero the strings run smoothly.
 */
export function Demo({ demo, children }: { demo: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let data: unknown, player: LottiePlayer | undefined, anim: HTMLDivElement | undefined, cancelled = false;

    const mount = async () => {
      if (player || !window.lottie) return;
      try {
        data ??= await (await fetch(demo)).json();
        if (cancelled || player) return;
        anim = document.createElement("div");
        anim.className = "anim";
        anim.setAttribute("aria-hidden", "true");
        el.append(anim);
        player = window.lottie.loadAnimation({ container: anim, renderer: "svg", loop: true, autoplay: true, animationData: data });
        el.classList.add("playing");
      } catch (error) {
        console.warn("lottie demo failed, keeping screenshot", error);
      }
    };
    const unmount = () => {
      player?.destroy(); player = undefined;
      anim?.remove(); anim = undefined;
      el.classList.remove("playing");
    };
    const observer = new IntersectionObserver(([entry]) => (entry.isIntersecting ? mount() : unmount()), { rootMargin: "240px 0px" });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); unmount(); };
  }, [demo]);
  return <div ref={frame} className="frame demo">{children}</div>;
}
