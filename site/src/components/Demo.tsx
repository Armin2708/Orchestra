import { useEffect, useRef, type ReactNode } from "react";

type LottiePlayer = { play(): void; pause(): void; destroy(): void; addEventListener(name: string, cb: () => void): void };
declare global {
  interface Window {
    lottie?: { loadAnimation: (opts: Record<string, unknown>) => LottiePlayer };
  }
}

/**
 * Screenshot (or terminal) fallback that upgrades to a looping Lottie demo while it is
 * near the viewport. The JSON is prefetched at idle and the player is mounted ~900px
 * before the frame scrolls in, so by the time it is visible the animation is already
 * rendering and just crossfades over the screenshot (see .frame.demo .anim in site.css).
 * It is destroyed again well below/above the viewport: idle Lottie SVGs near the hero
 * made the strings drop frames.
 */
export function Demo({ demo, children }: { demo: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frame.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let data: Promise<unknown> | undefined, player: LottiePlayer | undefined, anim: HTMLDivElement | undefined, cancelled = false;
    const prefetch = () => (data ??= fetch(demo).then((r) => r.json()));
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    idle ? idle(prefetch) : setTimeout(prefetch, 800);

    const mount = async () => {
      if (player || !window.lottie) return;
      try {
        const animationData = await prefetch();
        if (cancelled || player) return;
        anim = document.createElement("div");
        anim.className = "anim";
        anim.setAttribute("aria-hidden", "true");
        el.append(anim);
        player = window.lottie.loadAnimation({ container: anim, renderer: "svg", loop: true, autoplay: true, animationData });
        player.addEventListener("DOMLoaded", () => el.classList.add("playing"));
      } catch (error) {
        console.warn("lottie demo failed, keeping screenshot", error);
      }
    };
    const unmount = () => {
      el.classList.remove("playing");
      player?.destroy(); player = undefined;
      anim?.remove(); anim = undefined;
    };
    const observer = new IntersectionObserver(([entry]) => (entry.isIntersecting ? mount() : unmount()), { rootMargin: "900px 0px" });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); unmount(); };
  }, [demo]);
  return <div ref={frame} className="frame demo">{children}</div>;
}
