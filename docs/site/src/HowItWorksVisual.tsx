import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { motion, useReducedMotion, AnimatePresence } from 'framer-motion';
import {
  LogOut,
  MessageSquarePlus,
  Hash,
  Plug,
  Search,
  ArrowRight,
  ArrowDown,
  ExternalLink,
  Sparkles,
  Zap,
} from 'lucide-react';

type Source = {
  icon: typeof LogOut;
  label: string;
  x: number;
  y: number;
};

const SOURCES: Source[] = [
  { icon: LogOut, label: 'SessionEnd hook', x: 4, y: 22 },
  { icon: MessageSquarePlus, label: '/remember', x: 13, y: 3 },
  { icon: Hash, label: 'Hash line (#)', x: 25, y: 3 },
  { icon: Plug, label: 'memory_write (MCP)', x: 33, y: 22 },
];

const CAPTURE = { x: 15, y: 58 };
const CONSOLIDATE = { x: 42, y: 58 };
const RECALL = { x: 69, y: 58 };
const MCP = { x: 85, y: 90 };

type DbOpKind = 'write' | 'read' | 'compact';

type DbOp = {
  op: string;
  kind: DbOpKind;
};

type ExternalCall = {
  icon: typeof Sparkles;
  label: string;
};

type StageContent = {
  number: number;
  label: string;
  tagline: string;
  plainCaption: string;
  accent: string;
  dbOps: DbOp[];
  external?: ExternalCall[];
};

type BranchContent = {
  label: string;
  tagline: string;
  accent: string;
  dbOps: DbOp[];
};

const KIND_COLOR: Record<DbOpKind, string> = {
  write: '#85AB8B',
  compact: '#336443',
  read: '#00684A',
};

const KIND_LABEL: Record<DbOpKind, string> = {
  write: 'Write',
  compact: 'Compact',
  read: 'Read',
};

const STAGES: StageContent[] = [
  {
    number: 1,
    label: 'Capture',
    tagline: 'Four writers append. Nothing blocks.',
    plainCaption: 'Every time you use Claude Code, what happens gets written down instantly.',
    accent: '#85AB8B',
    dbOps: [{ op: 'observations.insertOne()', kind: 'write' }],
  },
  {
    number: 2,
    label: 'Consolidate',
    tagline: 'Offline. The only place judgment happens.',
    plainCaption: "Later, in the background, Claude reads those notes and decides what's actually worth keeping.",
    accent: '#336443',
    dbOps: [
      { op: 'observations.updateMany()', kind: 'compact' },
      { op: 'beliefs (vector dedupe)', kind: 'compact' },
      { op: 'briefs.replaceOne()', kind: 'compact' },
    ],
    external: [
      { icon: Sparkles, label: 'Claude (Bedrock/Anthropic): extractFacts()' },
      { icon: Zap, label: 'Voyage AI: embed() (skipped when Atlas autoEmbed is on)' },
    ],
  },
  {
    number: 3,
    label: 'Retrieve',
    tagline: 'One indexed lookup. No embedding, no search.',
    plainCaption: 'Next session, Claude already knows it. No searching required.',
    accent: '#00684A',
    dbOps: [{ op: 'briefs.findOne()', kind: 'read' }],
  },
];

const MCP_BRANCH: BranchContent = {
  label: 'MCP tools',
  tagline: 'On demand: search, write, forget.',
  accent: '#4b5b47',
  dbOps: [
    { op: 'search: beliefs.aggregate()', kind: 'read' },
    { op: 'write: observations.insertOne()', kind: 'write' },
    { op: 'forget: beliefs.updateOne()', kind: 'compact' },
  ],
};

const STAGE_INTERVAL_MS = 3200;

function bend(x1: number, y1: number, x2: number, y2: number, lift: number) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - lift;
  return { mx, my, d: `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}` };
}

function NodeCard({
  label,
  caption,
  accent,
  dbOps,
  external,
  number,
  badge,
  active,
  ambientPulse,
  onClick,
}: {
  label: string;
  caption: string;
  accent: string;
  dbOps?: DbOp[];
  external?: ExternalCall[];
  number?: number;
  badge?: string;
  active?: boolean;
  ambientPulse?: boolean;
  onClick?: () => void;
}) {
  const interactive = typeof onClick === 'function';

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <motion.div
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? active : undefined}
      aria-label={interactive ? `Jump to ${label}` : undefined}
      animate={
        ambientPulse
          ? {
              boxShadow: [`0 0 0 1px ${accent}22`, `0 0 0 9px ${accent}18`, `0 0 0 1px ${accent}22`],
            }
          : {
              scale: active ? 1.05 : 1,
              opacity: active === false ? 0.55 : 1,
              boxShadow: active ? `0 0 0 2px ${accent}, 0 0 20px 4px ${accent}66` : `0 0 0 1px ${accent}22`,
            }
      }
      transition={ambientPulse ? { duration: 4.5, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.45, ease: 'easeInOut' }}
      className={`relative bg-white/80 backdrop-blur-md border border-white/60 shadow-sm rounded-2xl px-4 py-3 text-center ${
        interactive ? 'cursor-pointer' : ''
      }`}
    >
      {typeof number === 'number' && (
        <span
          className="absolute -top-2 -left-2 flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white shadow-sm"
          style={{ backgroundColor: accent }}
          aria-hidden="true"
        >
          {number}
        </span>
      )}
      {badge && (
        <span
          className="absolute -top-2 -left-2 bg-[#4b5b47] text-white text-[9px] font-semibold uppercase tracking-wide rounded-full px-2 py-1 whitespace-nowrap shadow-sm"
          aria-hidden="true"
        >
          {badge}
        </span>
      )}
      <span className="block text-sm font-semibold" style={{ color: accent }}>
        {label}
      </span>
      <span
        className={`block mt-1 text-xs text-[#4b5b47] leading-snug ${external ? 'max-w-[16rem]' : 'max-w-[11rem]'}`}
      >
        {caption}
      </span>
      {dbOps && dbOps.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[#4b5b47]/15 flex flex-col items-center gap-1">
          {dbOps.map(({ op, kind }) => (
            <span key={op} className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: KIND_COLOR[kind] }} />
              <code className="font-mono text-[10px] leading-tight text-[#2d3a2a] whitespace-nowrap">{op}</code>
            </span>
          ))}
        </div>
      )}
      {external && external.length > 0 && (
        <div className="mt-2 pt-2 border-t border-dashed border-[#4b5b47]/30 flex flex-col items-center gap-1">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[#4b5b47]/70">Talks to:</span>
          {external.map(({ icon: Icon, label: extLabel }) => (
            <span key={extLabel} className="inline-flex items-center gap-1 text-[9px] font-medium text-[#4b5b47]/80">
              <Icon className="w-2.5 h-2.5 shrink-0" />
              <span className="whitespace-nowrap">{extLabel}</span>
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function SourceBadge({ icon: Icon, label }: { icon: typeof LogOut; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-white/80 backdrop-blur-md border border-white/60 shadow-sm rounded-full px-3 py-1.5 text-[11px] font-medium text-[#4b5b47] whitespace-nowrap">
      <Icon className="w-3.5 h-3.5 text-[#85AB8B]" />
      {label}
    </span>
  );
}

function McpBranchCard() {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="flex items-center justify-center w-7 h-7 rounded-full bg-[#4b5b47]/10">
        <Search className="w-3.5 h-3.5 text-[#4b5b47]" />
      </span>
      <NodeCard
        label={MCP_BRANCH.label}
        caption={MCP_BRANCH.tagline}
        accent={MCP_BRANCH.accent}
        dbOps={MCP_BRANCH.dbOps}
        badge="Anytime"
        ambientPulse
      />
    </div>
  );
}

function StaticFallback() {
  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-8">
      <ol className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-4">
        {STAGES.map((stage, i) => (
          <li key={stage.label} className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-4 flex-1">
            <div className="flex-1">
              <NodeCard
                label={stage.label}
                caption={stage.tagline}
                accent={stage.accent}
                number={stage.number}
                dbOps={stage.dbOps}
                external={stage.external}
              />
              <p className="mt-3 text-sm text-[#1f2a1d] leading-snug max-w-xs mx-auto">{stage.plainCaption}</p>
            </div>
            {i < STAGES.length - 1 && (
              <div className="flex items-center justify-center shrink-0">
                <ArrowRight className="hidden lg:block w-5 h-5 text-[#336443]/40" />
                <ArrowDown className="lg:hidden w-5 h-5 text-[#336443]/40" />
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="flex justify-center">
        <div className="w-full max-w-[13rem]">
          <McpBranchCard />
        </div>
      </div>
    </div>
  );
}

function DesktopDiagram({ activeIndex, onJump }: { activeIndex: number; onJump: (i: number) => void }) {
  const capToCons = bend(CAPTURE.x, CAPTURE.y, CONSOLIDATE.x, CONSOLIDATE.y, 10);
  const consToRecall = bend(CONSOLIDATE.x, CONSOLIDATE.y, RECALL.x, RECALL.y, 10);
  const recallToMcp = bend(RECALL.x, RECALL.y, MCP.x, MCP.y, -6);

  const sourcesActive = activeIndex === 0;
  const capToConsActive = activeIndex === 1;
  const consToRecallActive = activeIndex === 2;

  return (
    <div className="relative h-[380px] max-w-6xl mx-auto">
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {SOURCES.map((s) => {
          const path = bend(s.x, s.y, CAPTURE.x, CAPTURE.y, -6);
          return (
            <path
              key={s.label}
              d={path.d}
              fill="none"
              stroke="#4b5b47"
              strokeOpacity={sourcesActive ? 0.35 : 0.15}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        <path
          d={capToCons.d}
          fill="none"
          stroke="#4b5b47"
          strokeOpacity={capToConsActive ? 0.45 : 0.18}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={consToRecall.d}
          fill="none"
          stroke="#4b5b47"
          strokeOpacity={consToRecallActive ? 0.45 : 0.18}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={recallToMcp.d}
          fill="none"
          stroke="#4b5b47"
          strokeOpacity="0.18"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        {sourcesActive &&
          SOURCES.map((s, i) => {
            const path = bend(s.x, s.y, CAPTURE.x, CAPTURE.y, -6);
            return (
              <motion.div
                key={s.label}
                className="absolute w-2 h-2 rounded-full"
                style={{ backgroundColor: '#85AB8B', left: `${s.x}%`, top: `${s.y}%`, translateX: '-50%', translateY: '-50%' }}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{
                  left: [`${s.x}%`, `${path.mx}%`, `${CAPTURE.x}%`],
                  top: [`${s.y}%`, `${path.my}%`, `${CAPTURE.y}%`],
                  opacity: [0, 1, 0],
                  scale: [0.6, 1, 0.4],
                }}
                transition={{ duration: 1.1, delay: i * 0.18, ease: 'easeInOut' }}
              />
            );
          })}

        {capToConsActive && (
          <motion.div
            className="absolute w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: '#85AB8B', left: `${CAPTURE.x}%`, top: `${CAPTURE.y}%`, translateX: '-50%', translateY: '-50%' }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{
              left: [`${CAPTURE.x}%`, `${capToCons.mx}%`, `${CONSOLIDATE.x}%`],
              top: [`${CAPTURE.y}%`, `${capToCons.my}%`, `${CONSOLIDATE.y}%`],
              opacity: [0, 1, 1, 0],
              scale: [0.5, 1, 1, 0.6],
            }}
            transition={{ duration: 1.3, ease: 'easeInOut' }}
          />
        )}

        {consToRecallActive && (
          <motion.div
            className="absolute w-3 h-3 rounded-full"
            style={{
              backgroundColor: '#336443',
              boxShadow: '0 0 8px 2px rgba(51,100,67,0.5)',
              left: `${CONSOLIDATE.x}%`,
              top: `${CONSOLIDATE.y}%`,
              translateX: '-50%',
              translateY: '-50%',
            }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{
              left: [`${CONSOLIDATE.x}%`, `${consToRecall.mx}%`, `${RECALL.x}%`],
              top: [`${CONSOLIDATE.y}%`, `${consToRecall.my}%`, `${RECALL.y}%`],
              opacity: [0, 1, 1, 0],
              scale: [0.5, 1.2, 1, 0.6],
            }}
            transition={{ duration: 1.3, ease: 'easeInOut' }}
          />
        )}

        <motion.div
          className="absolute w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: '#4b5b47', left: `${RECALL.x}%`, top: `${RECALL.y}%`, translateX: '-50%', translateY: '-50%' }}
          animate={{
            left: [`${RECALL.x}%`, `${recallToMcp.mx}%`, `${MCP.x}%`],
            top: [`${RECALL.y}%`, `${recallToMcp.my}%`, `${MCP.y}%`],
            opacity: [0, 0.7, 0.7, 0],
          }}
          transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 2.2, ease: 'easeInOut' }}
        />
      </div>

      {consToRecallActive && (
        <motion.div
          className="absolute"
          style={{ left: `${RECALL.x}%`, top: `${RECALL.y - 22}%`, translateX: '-50%', translateY: '-50%' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3.2, times: [0, 0.15, 0.85, 1] }}
          aria-hidden="true"
        >
          <span className="inline-block bg-[#00684A]/10 text-[#00684A] text-[10px] font-semibold rounded-full px-2.5 py-1 whitespace-nowrap">
            New session
          </span>
        </motion.div>
      )}

      {SOURCES.map((s) => (
        <div key={s.label} className="absolute" style={{ left: `${s.x}%`, top: `${s.y}%`, transform: 'translate(-50%, -50%)' }}>
          <SourceBadge icon={s.icon} label={s.label} />
        </div>
      ))}

      <ol className="contents">
        {STAGES.map((stage, i) => {
          const pos = i === 0 ? CAPTURE : i === 1 ? CONSOLIDATE : RECALL;
          const isActive = i === activeIndex;
          return (
            <li key={stage.label} className="absolute" style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)' }}>
              <NodeCard
                label={stage.label}
                caption={stage.tagline}
                accent={stage.accent}
                number={stage.number}
                active={isActive}
                dbOps={isActive ? stage.dbOps : undefined}
                external={isActive ? stage.external : undefined}
                onClick={() => onJump(i)}
              />
            </li>
          );
        })}
      </ol>

      <div className="absolute" style={{ left: `${MCP.x}%`, top: `${MCP.y}%`, transform: 'translate(-50%, -50%)' }}>
        <McpBranchCard />
      </div>
    </div>
  );
}

function MobileDiagram({ activeIndex, onJump }: { activeIndex: number; onJump: (i: number) => void }) {
  return (
    <div className="flex flex-col items-stretch gap-3 max-w-sm mx-auto">
      <div className="flex flex-wrap items-center justify-center gap-2 mb-1" aria-hidden="true">
        {SOURCES.map((s) => (
          <SourceBadge key={s.label} icon={s.icon} label={s.label} />
        ))}
      </div>

      <ol className="contents">
        {STAGES.map((stage, i) => {
          const isActive = i === activeIndex;
          const feedsNext = i + 1 === activeIndex;
          return (
            <li key={stage.label} className="contents">
              <NodeCard
                label={stage.label}
                caption={stage.tagline}
                accent={stage.accent}
                number={stage.number}
                active={isActive}
                dbOps={isActive ? stage.dbOps : undefined}
                external={isActive ? stage.external : undefined}
                onClick={() => onJump(i)}
              />
              {i < STAGES.length - 1 && (
                <div className="relative flex items-center justify-center h-8" aria-hidden="true">
                  <ArrowDown className={`w-5 h-5 ${feedsNext ? 'text-[#336443]/60' : 'text-[#336443]/40'}`} />
                  {feedsNext && (
                    <motion.div
                      className="absolute w-2 h-2 rounded-full"
                      style={{ backgroundColor: stage.accent }}
                      initial={{ y: -14, opacity: 0 }}
                      animate={{ y: [-14, 14], opacity: [0, 1, 0] }}
                      transition={{ duration: 1.1, ease: 'easeInOut' }}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="relative flex items-center justify-center h-8" aria-hidden="true">
        <ArrowDown className="w-5 h-5 text-[#4b5b47]/30" strokeDasharray="4 3" />
        <motion.div
          className="absolute w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: '#4b5b47' }}
          animate={{ y: [-14, 14], opacity: [0, 0.7, 0] }}
          transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 2.2, ease: 'easeInOut' }}
        />
      </div>

      <McpBranchCard />
    </div>
  );
}

function HowItWorksVisual() {
  const prefersReducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const id = setInterval(() => {
      setActiveIndex((i) => (i + 1) % STAGES.length);
    }, STAGE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [resetKey, prefersReducedMotion]);

  function jumpToStage(i: number) {
    setActiveIndex(i);
    setResetKey((k) => k + 1);
  }

  const activeKinds = Array.from(new Set(STAGES[activeIndex].dbOps.map((op) => op.kind)));

  return (
    <section id="pipeline" className="relative w-full bg-[#f7f5ef] py-16 sm:py-20 md:py-28 px-4 sm:px-6 overflow-hidden">
      <div className="max-w-5xl mx-auto text-center mb-12 sm:mb-16">
        <span className="mb-2 sm:mb-3 inline-block text-[#4b5b47] text-xs sm:text-sm font-semibold uppercase tracking-[0.2em]">
          One MongoDB Platform
        </span>
        <h2
          className="font-normal leading-[1.05] text-[#336443] text-2xl sm:text-3xl md:text-4xl max-w-3xl mx-auto"
          style={{
            fontFamily:
              '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
            letterSpacing: '-0.03em',
          }}
        >
          Capture. Consolidate. Retrieve.
        </h2>
        <p className="mt-3 sm:mt-4 text-[#4b5b47] text-sm sm:text-base max-w-xl mx-auto">
          Four independent writers feed one offline consolidator. Every session starts from a small, ranked brief.
        </p>
      </div>

      {prefersReducedMotion ? (
        <StaticFallback />
      ) : (
        <>
          <div className="hidden lg:block">
            <DesktopDiagram activeIndex={activeIndex} onJump={jumpToStage} />
          </div>
          <div className="lg:hidden">
            <MobileDiagram activeIndex={activeIndex} onJump={jumpToStage} />
          </div>

          <div className="max-w-xl mx-auto text-center mt-8 sm:mt-10 min-h-[3.5rem] sm:min-h-[3rem] px-2">
            <AnimatePresence mode="wait">
              <motion.p
                key={activeIndex}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.35, ease: 'easeInOut' }}
                className="text-[#1f2a1d] text-lg sm:text-xl font-medium leading-snug"
              >
                {STAGES[activeIndex].plainCaption}
              </motion.p>
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-center gap-3 mt-3 text-[10px] sm:text-xs font-medium text-[#4b5b47]/60">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeIndex}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="flex items-center gap-3"
              >
                {activeKinds.map((kind) => (
                  <span key={kind} className="inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: KIND_COLOR[kind] }} />
                    {KIND_LABEL[kind]}
                  </span>
                ))}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-center gap-2 mt-6 sm:mt-8">
            {STAGES.map((stage, i) => (
              <span
                key={stage.label}
                className={`h-1.5 rounded-full transition-all duration-500 ${
                  i === activeIndex ? 'w-6 bg-[#336443]' : 'w-1.5 bg-[#336443]/20'
                }`}
              />
            ))}
          </div>
        </>
      )}

      <div className="flex items-center justify-center mt-8 sm:mt-10">
        <a
          href="https://github.com/saiteja05/mongo-claude-memory#architecture-overview"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 sm:mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[#336443] hover:text-[#1f2a1d] transition-colors"
        >
          More info
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </section>
  );
}

export default HowItWorksVisual;
