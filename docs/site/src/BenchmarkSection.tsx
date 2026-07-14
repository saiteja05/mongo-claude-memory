import { FlaskConical, Split, Gavel, BarChart3, ExternalLink } from 'lucide-react';

type BenchmarkLink = {
  icon: typeof FlaskConical;
  title: string;
  description: string;
  href: string;
};

const BENCHMARK_LINKS: BenchmarkLink[] = [
  {
    icon: FlaskConical,
    title: 'How the benchmark works',
    description:
      'Five seeded conversations about a fictional payments service, then 12 follow-up questions days later with no shared history. Each arm runs in its own isolated config directory and, for the engine arms, its own database.',
    href: 'https://github.com/saiteja05/mongo-claude-memory#benchmarking-the-memory-gauntlet',
  },
  {
    icon: Split,
    title: 'The four arms',
    description:
      "No memory at all (the guessability floor), Claude Code's own CLAUDE.md and auto-memory, this engine alone, and both running together, the realistic day to day setup for most users.",
    href: 'https://github.com/saiteja05/mongo-claude-memory#the-four-arms',
  },
  {
    icon: Gavel,
    title: 'Grading and adjudication',
    description:
      'Word-boundary keyword matching grades every answer first. A blinded LLM judge that never learns which arm produced an answer reviews disagreements before any override is applied.',
    href: 'https://github.com/saiteja05/mongo-claude-memory#grading-and-adjudication',
  },
  {
    icon: BarChart3,
    title: 'Latest results',
    description:
      'Full per-fact breakdown, confidence intervals, and the raw adjudication data behind the numbers above, from the most recent run that cleared blinded judge review.',
    href: 'https://github.com/saiteja05/mongo-claude-memory#latest-results',
  },
];

type Stat = {
  value: string;
  label: string;
  accent?: boolean;
};

const RECALL_STATS: Stat[] = [
  { value: '8%', label: 'No memory' },
  { value: '42%', label: "Claude's own memory" },
  { value: '92%', label: 'This engine', accent: true },
];

const CAPTURE_STATS: Stat[] = [
  { value: '42%', label: "Claude's own memory" },
  { value: '83%', label: 'This engine', accent: true },
];

const HEADING_FONT =
  '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

function BenchmarkLinkCard({ icon: Icon, title, description, href }: BenchmarkLink) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col gap-2 rounded-2xl border border-white/60 bg-white/80 backdrop-blur-md shadow-sm px-5 py-5 hover:bg-white/95 transition-colors"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-[#00684A] shrink-0" />
        <span className="text-sm sm:text-base font-semibold text-[#1f2a1d]">{title}</span>
      </div>
      <p className="text-xs sm:text-sm text-[#4b5b47]/80 leading-snug">{description}</p>
      <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[#336443] group-hover:text-[#1f2a1d] transition-colors">
        View on GitHub
        <ExternalLink className="w-3 h-3" />
      </span>
    </a>
  );
}

function StatChip({ value, label, accent }: Stat) {
  return (
    <div
      className={
        accent
          ? 'flex flex-col items-center gap-1 rounded-2xl border-2 bg-white/90 px-3 py-4 sm:py-5'
          : 'flex flex-col items-center gap-1 rounded-2xl border border-white/60 bg-white/70 px-3 py-4 sm:py-5'
      }
      style={accent ? { borderColor: '#00684A', boxShadow: '0 0 0 1px #00684A22' } : undefined}
    >
      <span
        className={accent ? 'text-3xl sm:text-4xl font-normal text-[#00684A]' : 'text-3xl sm:text-4xl font-normal text-[#4b5b47]'}
        style={{ fontFamily: HEADING_FONT }}
      >
        {value}
      </span>
      <span className="text-xs sm:text-sm font-medium text-[#4b5b47]/80 text-center">{label}</span>
    </div>
  );
}

function BenchmarkSection() {
  return (
    <section id="benchmark" className="relative w-full bg-[#f7f5ef] py-16 sm:py-20 md:py-28 px-4 sm:px-6 overflow-hidden">
      <div className="max-w-5xl mx-auto text-center mb-12 sm:mb-16">
        <span className="mb-2 sm:mb-3 inline-block text-[#4b5b47] text-xs sm:text-sm font-semibold uppercase tracking-[0.2em]">
          Independently measured
        </span>
        <h2
          className="font-normal leading-[1.05] text-[#336443] text-2xl sm:text-3xl md:text-4xl max-w-3xl mx-auto"
          style={{ fontFamily: HEADING_FONT, letterSpacing: '-0.03em' }}
        >
          Benchmarked, not just claimed.
        </h2>
        <p className="mt-3 sm:mt-4 text-[#4b5b47] text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
          The recall improvement described on this page is measured, not asserted. A four-arm benchmark runs the same
          set of scenarios against this engine, against Claude Code's native memory, and against no memory at all, each
          isolated in its own arm. Every answer is graded by keyword matching first, then cross-checked by a blinded
          LLM judge that never learns which arm produced it, keeping the grading independent of the system being
          tested.
        </p>
      </div>

      <div className="max-w-3xl mx-auto mb-10 sm:mb-12">
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          {RECALL_STATS.map((stat) => (
            <StatChip key={stat.label} {...stat} />
          ))}
        </div>
        <p className="mt-4 sm:mt-5 text-center text-xs sm:text-sm text-[#4b5b47]/80 leading-relaxed">
          Recall: asked again later, in a fresh session with no shared history, how often Claude answered correctly.
        </p>

        <div className="mt-8 pt-6 border-t border-[#4b5b47]/15">
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            {CAPTURE_STATS.map((stat) => (
              <StatChip key={stat.label} {...stat} />
            ))}
          </div>
          <p className="mt-3 text-center text-xs sm:text-sm text-[#4b5b47]/70">
            Capture: whether the fact got saved anywhere at all, before recall is even tested. This engine leads on both.
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-4">
        {BENCHMARK_LINKS.map((link) => (
          <BenchmarkLinkCard key={link.href} {...link} />
        ))}
      </div>

      <p className="max-w-2xl mx-auto mt-8 sm:mt-10 text-center text-xs sm:text-sm text-[#4b5b47]/70 leading-relaxed">
        The latest run completed on 2026-07-14 and cleared blinded judge review. Results are published in the
        README's Latest results section linked above, so the numbers you find there are always from the most recent
        run that cleared that bar.
      </p>
    </section>
  );
}

export default BenchmarkSection;
