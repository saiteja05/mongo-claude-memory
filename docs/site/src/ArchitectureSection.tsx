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
  { icon: Database, color: '#85AB8B', name: 'observations', caption: 'Notes land here first, the moment they happen.' },
  { icon: Sparkles, color: '#336443', name: 'beliefs', caption: 'The facts worth keeping, sorted and saved for good.' },
  { icon: FileText, color: '#00684A', name: 'briefs', caption: 'The short summary Claude actually reads.' },
  { icon: Lock, color: '#4b5b47', name: 'locks', caption: 'Makes sure cleanup never runs twice at once.', muted: true },
];

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
      <div className="relative inline-flex items-center gap-1.5 bg-white/80 backdrop-blur-md border border-white/60 shadow-sm rounded-full px-3.5 py-1.5">
        <Terminal className="w-3.5 h-3.5 text-[#4b5b47]" />
        <span className="text-xs sm:text-sm font-semibold text-[#1f2a1d]">Claude Code</span>
      </div>
      <span className="text-[11px] text-[#4b5b47]/70">Claude Code, unmodified</span>
    </div>
  );
}

function TouchpointRow({ icon: Icon, label, caption }: Touchpoint) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-5 h-5 shrink-0 mt-0.5 text-[#4b5b47]" />
      <div className="flex flex-col">
        <span className="text-sm sm:text-base font-bold text-[#4b5b47]">{label}</span>
        <span className="text-xs sm:text-sm text-[#4b5b47]/70 leading-snug">{caption}</span>
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
      <span className="text-[11px] sm:text-xs text-[#4b5b47]/70 leading-snug">{caption}</span>
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
          Claude Code only ever reaches memory through three doors: hooks, a slash command, and an MCP server.
        </p>
      </div>

      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-stretch md:items-center gap-6">
        <div className="relative flex-1 min-w-0 bg-white/80 backdrop-blur-md border border-white/60 shadow-sm rounded-2xl overflow-hidden px-5 sm:px-8 py-8 sm:py-10">
          <motion.div className="flex justify-center mb-6" {...revealProps(0)}>
            <ClaudeCodePill />
          </motion.div>

          <div className="flex flex-col gap-5">
            {TOUCHPOINTS.map((tp, i) => (
              <motion.div key={tp.label} {...revealProps(i * 0.07)}>
                <TouchpointRow icon={tp.icon} label={tp.label} caption={tp.caption} />
              </motion.div>
            ))}
          </div>

          <p className="mt-6 text-[11px] text-[#4b5b47]/60 text-center">
            Remove all three, and Claude Code goes back to stock. Nothing left behind.
          </p>
        </div>

        <div className="flex items-center justify-center shrink-0 md:w-12">
          <ArrowRight className="hidden md:block w-8 h-8" style={{ color: '#336443' }} />
          <ArrowDown className="md:hidden w-8 h-8" style={{ color: '#336443' }} />
        </div>

        <motion.div
          className="relative flex-1 min-w-0 rounded-2xl border-2 bg-white/70 backdrop-blur-md overflow-hidden px-5 sm:px-8 py-8 sm:py-10"
          style={{ borderColor: '#00684A', boxShadow: '0 0 0 1px #00684A22, 0 10px 28px -10px #00684A66' }}
          {...revealProps(0.1)}
        >
          <h3
            className="text-center text-base sm:text-lg font-semibold"
            style={{ fontFamily: HEADING_FONT, color: '#336443' }}
          >
            MongoDB Atlas
          </h3>
          <div className="grid grid-cols-2 gap-3 mt-4">
            {COLLECTIONS.map((c, i) => (
              <motion.div key={c.name} {...revealProps(i * 0.07)}>
                <CollectionChipCard {...c} />
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>

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
                className="flex items-center gap-2 rounded-xl border border-[#9a9a90]/30 bg-white/60 px-3 py-2"
              >
                <chip.icon className="w-4 h-4 text-gray-400" />
                <span className="text-xs sm:text-sm font-medium text-gray-500">{chip.label}</span>
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
