import { useEffect, useRef, useState } from 'react';

type Props = {
  src: string;
  className?: string;
};

export default function BoomerangVideoBg({ src, className }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [framesReady, setFramesReady] = useState(false);
  const framesRef = useRef<HTMLCanvasElement[]>([]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const frames: HTMLCanvasElement[] = [];
    let capturing = true;
    let lastTime = -1;
    const MAX_WIDTH = 960;

    const captureFrame = () => {
      if (!capturing || video.readyState < 2) return;
      if (video.currentTime === lastTime) return;
      lastTime = video.currentTime;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const scale = Math.min(1, MAX_WIDTH / vw);
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(canvas);
    };

    type VFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const vfcVideo = video as VFCVideo;
    const hasVFC = typeof vfcVideo.requestVideoFrameCallback === 'function';

    let rafId = 0;
    const rafLoop = () => {
      captureFrame();
      if (capturing) rafId = requestAnimationFrame(rafLoop);
    };

    const vfcLoop = () => {
      captureFrame();
      if (capturing && vfcVideo.requestVideoFrameCallback) {
        vfcVideo.requestVideoFrameCallback(vfcLoop);
      }
    };

    const onEnded = () => {
      capturing = false;
      if (frames.length > 0) {
        framesRef.current = frames;
        setFramesReady(true);
      }
    };

    const onLoaded = () => {
      video.play().catch(() => {});
      if (hasVFC) {
        vfcVideo.requestVideoFrameCallback!(vfcLoop);
      } else {
        rafId = requestAnimationFrame(rafLoop);
      }
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('ended', onEnded);
    if (video.readyState >= 1) onLoaded();

    return () => {
      capturing = false;
      cancelAnimationFrame(rafId);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('ended', onEnded);
    };
  }, [src]);

  useEffect(() => {
    if (!framesReady) return;
    const canvas = displayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const frames = framesRef.current;
    if (frames.length === 0) return;

    const first = frames[0];
    canvas.width = first.width;
    canvas.height = first.height;

    // Paint the first frame immediately so the canvas is never blank while the
    // IntersectionObserver settles (or under reduced motion, where it stays put).
    ctx.drawImage(first, 0, 0);

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reduced motion: leave the single still frame (same nature bridge), no loop.
    if (prefersReducedMotion) {
      return;
    }

    let index = 0;
    let direction = 1;
    let last = performance.now();
    const interval = 1000 / 30;
    let rafId = 0;
    let running = false;

    const render = (now: number) => {
      if (now - last >= interval) {
        last = now;
        ctx.drawImage(frames[index], 0, 0);
        index += direction;
        if (index >= frames.length - 1) {
          index = frames.length - 1;
          direction = -1;
        } else if (index <= 0) {
          index = 0;
          direction = 1;
        }
      }
      rafId = requestAnimationFrame(render);
    };

    // start/stop preserve index and direction (they live in this effect scope),
    // so resuming after the hero scrolls back in continues smoothly.
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      rafId = requestAnimationFrame(render);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafId);
    };

    const wrapper = wrapperRef.current;
    let observer: IntersectionObserver | null = null;

    if (wrapper && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          start();
        } else {
          stop();
        }
      });
      observer.observe(wrapper);
    } else {
      // No IntersectionObserver available: fall back to always running.
      start();
    }

    return () => {
      stop();
      if (observer) observer.disconnect();
    };
  }, [framesReady]);

  return (
    <div ref={wrapperRef} className={className ?? 'absolute inset-0 w-full h-full'}>
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-cover"
        style={{ display: framesReady ? 'none' : 'block' }}
        muted
        playsInline
        preload="auto"
        crossOrigin="anonymous"
      />
      <canvas
        ref={displayCanvasRef}
        className="w-full h-full object-cover"
        style={{ display: framesReady ? 'block' : 'none' }}
      />
    </div>
  );
}
