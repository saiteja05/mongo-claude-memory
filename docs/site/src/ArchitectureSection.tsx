import { motion, useReducedMotion } from 'framer-motion';
import {
  Database,
  Sparkles,
  Search,
  Lock,
  Terminal,
  Zap,
  MessageSquarePlus,
  Plug,
  FileText,
  ArrowRight,
  ArrowDown,
  ExternalLink,
} from 'lucide-react';

type IconType = typeof Database;

type Touchpoint = {
  icon: IconType;
  label: string;
  caption: string;
};

const TOUCHPOINTS: Touchpoint[] = [
  {
    icon: Zap,
    label: 'Hooks',
    caption: 'Quiet watchers built into Claude Code: session start, session end, and lines you start with #.',
  },
  {
    icon: MessageSquarePlus,
    label: '/remember',
    caption: 'You tell it to save something, on purpose.',
  },
  {
    icon: Plug,
    label: 'MCP server',
    caption: 'Three tools Claude can call anytime: search, save, or forget.',
  },
];

type CollectionChip = {
  icon: IconType;
  color: string;
  name: string;
  caption: string;
  muted?: boolean;
};

const COLLECTIONS: CollectionChip[] = [
  { icon: Database, color: '#85AB8B', name: 'observations', caption: 'Raw notes land here the instant something happens.' },
  { icon: Sparkles, color: '#336443', name: 'beliefs', caption: 'The offline consolidator turns them into a durable, deduplicated fact.' },
  { icon: FileText, color: '#00684A', name: 'briefs', caption: 'Compiled into the short, ranked summary Claude actually reads.' },
  { icon: Lock, color: '#4b5b47', name: 'locks', caption: 'Makes sure cleanup never runs twice at once.', muted: true },
];

type JourneyStop = {
  name: string;
  icon: IconType;
  color: string;
  description: string;
};

const JOURNEY_STOPS: JourneyStop[] = [
  {
    name: 'observations',
    icon: Database,
    color: '#85AB8B',
    description: 'A raw note, captured the instant something happens.',
  },
  {
    name: 'beliefs',
    icon: Sparkles,
    color: '#336443',
    description: 'A durable, deduplicated fact worth keeping.',
  },
  {
    name: 'briefs',
    icon: FileText,
    color: '#00684A',
    description: 'A short, ranked summary, capped to a small token budget.',
  },
  {
    name: 'Claude Code',
    icon: Terminal,
    color: '#4b5b47',
    description: 'Handed back at the next session start, already known.',
  },
];

const JOURNEY_TRANSFORMATIONS = ['consolidated offline', 'compiled and ranked', 'injected at session start'];

type WhyChip = {
  icon: IconType;
  label: string;
};

const WHY_CHIPS: WhyChip[] = [
  { icon: Database, label: 'A database' },
  { icon: Sparkles, label: 'A vector search service' },
  { icon: Search, label: 'A search engine' },
  { icon: Lock, label: 'A queue or lock service' },
];

const HEADING_FONT =
  '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

function ClaudeCodePill() {
  return (
    <div className="relative z-10 flex flex-col items-center gap-2">
      <div className="relative inline-flex items-center gap-1.5 bg-white/80 backdrop-blur-md border border-[#336443]/12 shadow-sm rounded-full px-3.5 py-1.5">
        <Terminal className="w-3.5 h-3.5 text-[#4b5b47]" />
        <span className="text-xs sm:text-sm font-semibold text-[#1f2a1d]">Claude Code</span>
      </div>
      <span className="text-[11px] text-[#4b5b47]">Claude Code, unmodified</span>
    </div>
  );
}

function TouchpointRow({ icon: Icon, label, caption }: Touchpoint) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-5 h-5 shrink-0 mt-0.5 text-[#4b5b47]" />
      <div className="flex flex-col">
        <span className="text-sm sm:text-base font-bold text-[#4b5b47]">{label}</span>
        <span className="text-xs sm:text-sm text-[#4b5b47] leading-snug">{caption}</span>
      </div>
    </div>
  );
}

function CollectionChipCard({ icon: Icon, color, name, caption, muted }: CollectionChip) {
  return (
    <div
      className={
        muted
          ? 'flex flex-col items-start gap-1.5 rounded-xl border border-dashed bg-white/80 px-3 py-2.5'
          : 'flex flex-col items-start gap-1.5 rounded-xl border-l-4 bg-white/80 px-3 py-2.5'
      }
      style={muted ? { borderColor: `${color}66` } : { borderLeftColor: color }}
    >
      <Icon className="w-4 h-4 shrink-0" style={{ color }} />
      <code className="font-mono text-xs sm:text-sm font-semibold text-[#1f2a1d]">{name}</code>
      <span className="text-[11px] sm:text-xs text-[#4b5b47] leading-snug">{caption}</span>
    </div>
  );
}

function JourneyStopCard({ name, icon: Icon, color, description }: JourneyStop) {
  const isEndpoint = name === 'Claude Code';
  return (
    <div
      className={`relative h-full flex flex-col items-center text-center gap-2.5 rounded-2xl bg-white/80 border border-[#336443]/12 shadow-sm px-4 sm:px-5 py-5 sm:py-6${isEndpoint ? ' justify-center' : ''}`}
      style={{ borderTopWidth: '3px', borderTopColor: color }}
    >
      <div
        className="flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full"
        style={{ backgroundColor: `${color}1a` }}
      >
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      {isEndpoint ? (
        <span className="text-sm sm:text-base font-semibold text-[#1f2a1d]">{name}</span>
      ) : (
        <code className="font-mono text-xs sm:text-sm font-semibold text-[#1f2a1d]">{name}</code>
      )}
      <span className="text-xs sm:text-sm text-[#4b5b47] leading-snug">{description}</span>
    </div>
  );
}

function JourneyConnector({ label }: { label: string }) {
  return (
    <div className="flex lg:flex-col items-center justify-center gap-2 lg:gap-1.5 py-1 lg:py-0 lg:w-24">
      <span className="hidden lg:block text-center text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-[#336443] leading-tight">
        {label}
      </span>
      <ArrowRight className="hidden lg:block w-6 h-6 shrink-0" style={{ color: '#00684A' }} />
      <ArrowDown className="lg:hidden w-5 h-5 shrink-0" style={{ color: '#00684A' }} />
      <span className="lg:hidden text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-[#336443] leading-tight">
        {label}
      </span>
    </div>
  );
}

function ArchitectureSection() {
  const prefersReducedMotion = useReducedMotion();

  function revealProps(delay: number) {
    if (prefersReducedMotion) return {};
    return {
      initial: { opacity: 0, y: 12 },
      whileInView: { opacity: 1, y: 0 },
      viewport: { once: true, amount: 0.4 },
      transition: { duration: 0.4, delay, ease: 'easeOut' as const },
    };
  }

  return (
    <section id="architecture" className="relative w-full bg-[#f7f5ef] py-16 sm:py-20 md:py-28 px-4 sm:px-6 overflow-hidden">
      <div className="max-w-5xl mx-auto text-center mb-12 sm:mb-16">
        <span className="mb-2 sm:mb-3 inline-block text-[#4b5b47] text-xs sm:text-sm font-semibold uppercase tracking-[0.2em]">
          One MongoDB Platform
        </span>
        <h2
          className="font-normal leading-[1.05] text-[#336443] text-2xl sm:text-3xl md:text-4xl max-w-3xl mx-auto"
          style={{ fontFamily: HEADING_FONT, letterSpacing: '-0.03em' }}
        >
          Three doors in. Four collections. One cluster.
        </h2>
        <p className="mt-3 sm:mt-4 text-[#4b5b47] text-sm sm:text-base max-w-xl mx-auto">
          Claude Code only ever reaches memory through three doors: hooks, a slash command, and an MCP server. Inside
          the cluster, an observation becomes a belief, and a belief becomes the brief that gets handed back at the
          next session start.
        </p>
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

      <motion.div className="max-w-3xl mx-auto flex justify-center" {...revealProps(0)}>
        <ClaudeCodePill />
      </motion.div>

      <div className="max-w-5xl mx-auto mt-6 grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
        {TOUCHPOINTS.map((tp, i) => (
          <motion.div
            key={tp.label}
            className="rounded-2xl bg-white/80 border border-[#336443]/12 shadow-sm px-4 sm:px-5 py-4 sm:py-5"
            {...revealProps(0.05 + i * 0.05)}
          >
            <TouchpointRow icon={tp.icon} label={tp.label} caption={tp.caption} />
          </motion.div>
        ))}
      </div>

      <p className="mt-4 text-[11px] sm:text-xs text-[#4b5b47] text-center max-w-xl mx-auto">
        Remove all three, and Claude Code goes back to stock. Nothing left behind.
      </p>

      <motion.div className="flex flex-col items-center gap-1 mt-6 mb-10 sm:mb-12" {...revealProps(0.25)}>
        <ArrowDown className="w-6 h-6" style={{ color: '#336443' }} />
        <span className="text-[11px] sm:text-xs text-[#4b5b47]">writes to memory</span>
      </motion.div>

      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col lg:flex-row items-stretch gap-5 lg:gap-3">
          <motion.div
            className="relative flex-[3] rounded-2xl bg-[#336443]/6 border border-[#00684A]/15 px-4 sm:px-6 pt-9 pb-5 sm:pb-6"
            {...revealProps(0)}
          >
            <span className="absolute top-3 left-4 sm:left-5 rounded-full bg-white/70 px-2 py-0.5 text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider text-[#336443]">
              One MongoDB Atlas cluster
            </span>

            <div className="flex flex-col lg:flex-row items-stretch gap-4 lg:gap-2">
              <motion.div className="flex-1 min-w-0" {...revealProps(0.05)}>
                <JourneyStopCard {...JOURNEY_STOPS[0]} />
              </motion.div>
              <motion.div className="flex shrink-0" {...revealProps(0.1)}>
                <JourneyConnector label={JOURNEY_TRANSFORMATIONS[0]} />
              </motion.div>
              <motion.div className="flex-1 min-w-0" {...revealProps(0.15)}>
                <JourneyStopCard {...JOURNEY_STOPS[1]} />
              </motion.div>
              <motion.div className="flex shrink-0" {...revealProps(0.2)}>
                <JourneyConnector label={JOURNEY_TRANSFORMATIONS[1]} />
              </motion.div>
              <motion.div className="flex-1 min-w-0" {...revealProps(0.25)}>
                <JourneyStopCard {...JOURNEY_STOPS[2]} />
              </motion.div>
            </div>
          </motion.div>

          <motion.div className="flex items-center justify-center shrink-0" {...revealProps(0.3)}>
            <JourneyConnector label={JOURNEY_TRANSFORMATIONS[2]} />
          </motion.div>

          <motion.div className="flex-1 min-w-0" {...revealProps(0.35)}>
            <JourneyStopCard {...JOURNEY_STOPS[3]} />
          </motion.div>
        </div>

        <motion.div className="max-w-2xl mx-auto mt-6 sm:mt-8 text-center" {...revealProps(0.4)}>
          <p className="text-xs sm:text-sm text-[#4b5b47] leading-relaxed">
            The compiled brief is re-injected at session start, and after every compaction, resume, and clear.
          </p>
          <p className="mt-1 text-xs sm:text-sm text-[#4b5b47] leading-relaxed">
            Every new session begins already knowing.
          </p>
        </motion.div>
      </div>

      <motion.div className="max-w-xs mx-auto mt-8 sm:mt-10 text-center" {...revealProps(0.45)}>
        <p className="text-[10px] sm:text-[11px] text-[#4b5b47] mb-2">
          Also inside the cluster, not part of the flow
        </p>
        <CollectionChipCard {...COLLECTIONS[3]} />
      </motion.div>

      <div className="max-w-4xl mx-auto mt-14 sm:mt-16 pt-8 sm:pt-10 border-t border-[#4b5b47]/15 text-center">
        <h3 className="text-lg sm:text-xl font-normal" style={{ fontFamily: HEADING_FONT, color: '#336443' }}>
          Why MongoDB
        </h3>
        <p className="mt-2 text-xs sm:text-sm text-[#4b5b47]">
          MongoDB Atlas quietly does the job of four separate services.
        </p>

        <div className="flex flex-col md:flex-row items-center justify-center gap-3 md:gap-4 mt-6">
          <div className="grid grid-cols-2 md:flex gap-3 md:gap-4">
            {WHY_CHIPS.map((chip) => (
              <div
                key={chip.label}
                className="flex items-center gap-2 rounded-xl border border-[#4b5b47]/20 bg-white/60 px-3 py-2"
              >
                <chip.icon className="w-4 h-4 text-[#4b5b47]/50" />
                <span className="text-xs sm:text-sm font-medium text-[#4b5b47]/70">{chip.label}</span>
              </div>
            ))}
          </div>

          <ArrowRight className="hidden md:block w-5 h-5" style={{ color: '#336443' }} />
          <ArrowDown className="md:hidden w-5 h-5" style={{ color: '#336443' }} />

          <div
            className="flex items-center gap-2 rounded-xl border-2 bg-white/80 px-3 py-2"
            style={{ borderColor: '#00684A' }}
          >
            <Database className="w-4 h-4" style={{ color: '#00684A' }} />
            <span className="text-xs sm:text-sm font-semibold" style={{ color: '#336443' }}>
              MongoDB Atlas
            </span>
          </div>
        </div>

        <p className="mt-6 text-xs sm:text-sm text-[#4b5b47] max-w-2xl mx-auto leading-relaxed">
          Capture, consolidation, and hybrid search all run as one MongoDB Aggregation pipeline. No standalone
          vector store or search service to wire up.
        </p>
      </div>
    </section>
  );
}

export default ArchitectureSection;
