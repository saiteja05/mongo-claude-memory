import { useState, useEffect, useRef } from 'react';
import { Play, Sparkles, Menu, X, Leaf, Star, BookOpen, Copy, Check } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { Reveal } from './motion';
import BoomerangVideoBg from './BoomerangVideoBg';
import ArchitectureSection from './ArchitectureSection';
import HowItWorksVisual from './HowItWorksVisual';
import BenchmarkSection from './BenchmarkSection';
import LiveDemoSection from './LiveDemoSection';

const BG_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260511_131941_d136af49-e243-493a-be14-6ff3f24e09e6.mp4';

const HERO_EASE = [0.22, 1, 0.36, 1] as const;

const INSTALL_COMMANDS = [
  'claude plugin marketplace add saiteja05/mongo-claude-memory',
  'claude plugin install recall',
];

function ClosingCta() {
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_COMMANDS.join('\n')).then(
      () => {
        setCopied(true);
        if (copyTimeout.current) {
          clearTimeout(copyTimeout.current);
        }
        copyTimeout.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard write was blocked; leave the button state unchanged.
      }
    );
  };

  return (
    <section id="get-started" className="bg-[#1f2a1d] py-16 sm:py-20 md:py-28 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto text-center">
        <Reveal delay={0}>
          <span className="uppercase tracking-[0.2em] text-xs sm:text-sm font-semibold text-[#85AB8B]">
            Get started
          </span>
        </Reveal>
        <Reveal delay={0.07} className="mt-4">
          <h2
            className="font-display font-normal text-2xl sm:text-3xl md:text-4xl text-[#f7f5ef]"
            style={{ letterSpacing: '-0.03em' }}
          >
            Give Claude a memory today.
          </h2>
        </Reveal>
        <Reveal delay={0.14} className="mt-4">
          <p className="text-[#f7f5ef]/80 max-w-2xl mx-auto">
            Two commands to install, then a one-time `npm install` in the resolved plugin directory. One command to remove: `claude plugin uninstall recall`, and Claude Code is back to stock, nothing left behind.
          </p>
        </Reveal>
        <Reveal delay={0.2} className="mt-8">
          <div className="max-w-xl mx-auto text-left rounded-2xl bg-[#171f15] border border-white/10 overflow-hidden">
            <div className="flex items-center gap-2 bg-black/30 px-4 py-3">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
              <span className="ml-2 text-xs font-mono text-white/50">bash</span>
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy install commands"
                className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-[#f7f5ef]/80 hover:text-[#f7f5ef] transition-colors"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="font-mono text-xs sm:text-sm text-[#f7f5ef]/90 px-4 sm:px-5 py-4 overflow-x-auto">
              {INSTALL_COMMANDS.join('\n')}
            </pre>
          </div>
        </Reveal>
        <p className="mt-4 text-sm text-[#f7f5ef]/70">
          The plugin registers the hooks, the MCP server, and the slash commands automatically.
        </p>
        <p className="mt-2 text-sm text-[#f7f5ef]/90">
          Before first use, you will still need to set your own credentials: a MongoDB Atlas
          connection string, an embedding credential (Voyage, or an Atlas model API key), and an
          LLM credential for fact extraction (Anthropic, AWS Bedrock, or a local Ollama server,
          which needs no API key). Full list in the{' '}
          <a
            href="https://github.com/saiteja05/mongo-claude-memory#configuration-reference"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-[#f7f5ef]"
          >
            configuration reference
          </a>
          .
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6">
          <a
            href="https://github.com/saiteja05/mongo-claude-memory#quick-start"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center bg-[#f7f5ef] text-[#1f2a1d] font-medium px-6 py-3 rounded-full hover:bg-white/90 transition-colors"
          >
            Install on GitHub
          </a>
          <a
            href="https://github.com/saiteja05/mongo-claude-memory#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#85AB8B] hover:text-[#f7f5ef] font-semibold transition-colors"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const footerLinks = [
    { href: '#architecture', label: 'Architecture', external: false },
    { href: '#pipeline', label: 'How it works', external: false },
    { href: '#benchmark', label: 'Benchmark', external: false },
    { href: '#how-it-works', label: 'Using it', external: false },
    { href: 'https://github.com/saiteja05/mongo-claude-memory', label: 'GitHub', external: true },
    { href: 'https://github.com/saiteja05/mongo-claude-memory#readme', label: 'Docs', external: true },
  ];

  return (
    <footer className="bg-[#171f15] py-12 sm:py-14 px-4 sm:px-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg sm:text-xl font-semibold text-[#f7f5ef]">Recall</span>
              <span className="text-[#f7f5ef]/60 text-xs sm:text-sm">for Claude Code</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Leaf className="w-4 h-4 text-[#85AB8B]" />
              <span className="text-[#85AB8B] text-sm">Built on MongoDB Atlas</span>
            </div>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {footerLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-[#f7f5ef]/70 hover:text-[#f7f5ef] text-sm transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="mt-10 pt-6 border-t border-[#f7f5ef]/10">
          <p className="text-[#f7f5ef]/50 text-xs">
            <a
              href="https://github.com/saiteja05/mongo-claude-memory"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#f7f5ef] transition-colors"
            >
              Open source on GitHub
            </a>
            .
          </p>
        </div>
      </div>
    </footer>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const firstDrawerLinkRef = useRef<HTMLAnchorElement>(null);
  const menuWasOpened = useRef(false);

  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  // Sticky nav: swap to a solid background once the hero scrolls away.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Scroll-spy: mark the nav link whose section is in the viewport band.
  useEffect(() => {
    const ids = ['architecture', 'pipeline', 'benchmark', 'how-it-works'];
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
    );
    for (const el of elements) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  // Close the mobile drawer on Escape while it is open.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  // Move focus into the drawer on open, and back to the hamburger on close.
  useEffect(() => {
    if (menuOpen) {
      menuWasOpened.current = true;
      firstDrawerLinkRef.current?.focus();
    } else if (menuWasOpened.current) {
      hamburgerRef.current?.focus();
    }
  }, [menuOpen]);

  const navLinks = [
    { href: '#architecture', label: 'Architecture' },
    { href: '#pipeline', label: 'How it works' },
    { href: '#benchmark', label: 'Benchmark' },
    { href: '#how-it-works', label: 'Using it' },
  ];

  const heroEntrance = (delay: number) =>
    reducedMotion
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: HERO_EASE },
        };

  return (
    <>
    <section className="relative w-full min-h-screen sm:h-screen overflow-hidden">
      <BoomerangVideoBg src={BG_VIDEO} className="absolute inset-0 w-full h-full" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40 sm:h-56 z-[5] bg-gradient-to-b from-transparent via-[#f7f5ef]/40 to-[#f7f5ef]"
      />
      <nav
        className={`fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 sm:px-6 md:px-10 py-4 sm:py-6 transition-colors duration-300 ${
          scrolled
            ? 'bg-[#f7f5ef]/90 backdrop-blur-md border-b border-[#4b5b47]/15 shadow-sm'
            : 'bg-transparent'
        }`}
      >
        <div className="flex items-baseline gap-2 text-[#2d3a2a]">
          <a href="/" className="text-lg sm:text-xl md:text-2xl font-semibold tracking-tight">
            Recall
          </a>
          <span className="hidden sm:inline text-[#4b5b47] font-medium text-xs sm:text-sm tracking-tight">
            for Claude Code
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-1 bg-white/70 backdrop-blur-md rounded-full pl-6 pr-1 py-1 shadow-sm border border-white/60">
          {navLinks.map((link) => {
            const isActive = link.href.startsWith('#') && activeSection === link.href.slice(1);
            return (
              <a
                key={link.href}
                href={link.href}
                {...(!link.href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                aria-current={isActive ? 'true' : undefined}
                className={`text-sm px-3 py-2 transition-colors ${
                  isActive ? 'font-semibold text-[#1f2a1d]' : 'font-medium text-[#4b5b47] hover:text-[#1f2a1d]'
                }`}
              >
                {link.label}
              </a>
            );
          })}
          <a
            href="https://github.com/saiteja05/mongo-claude-memory#quick-start"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 bg-[#1f2a1d] hover:bg-[#2a3827] text-white text-sm font-medium px-5 py-2.5 rounded-full transition-colors"
          >
            Install
          </a>
        </div>

        <div className="flex items-center gap-3 sm:gap-6 text-[#2d3a2a]">
          <a
            href="https://github.com/saiteja05/mongo-claude-memory"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-2 text-sm font-medium hover:opacity-80 transition-opacity"
          >
            <Star className="w-4 h-4" />
            Star on GitHub
          </a>
          <a
            href="https://github.com/saiteja05/mongo-claude-memory#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-2 text-sm font-medium hover:opacity-80 transition-opacity"
          >
            <BookOpen className="w-4 h-4" />
            Docs
          </a>
          <button
            ref={hamburgerRef}
            onClick={() => setMenuOpen((v) => !v)}
            className="lg:hidden relative flex items-center justify-center w-11 h-11 rounded-full bg-white/70 backdrop-blur-md border border-white/60 text-[#1f2a1d] transition-all duration-300 hover:bg-white/90"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            <Menu
              className={`w-5 h-5 absolute transition-all duration-300 ${
                menuOpen ? 'opacity-0 rotate-90 scale-50' : 'opacity-100 rotate-0 scale-100'
              }`}
            />
            <X
              className={`w-5 h-5 absolute transition-all duration-300 ${
                menuOpen ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-50'
              }`}
            />
          </button>
        </div>
      </nav>

      <div
        className={`lg:hidden fixed inset-0 z-20 transition-opacity duration-300 ${
          menuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setMenuOpen(false)}
      >
        <div className="absolute inset-0 bg-[#1f2a1d]/40 backdrop-blur-sm" />
      </div>

      <div
        inert={!menuOpen}
        aria-hidden={!menuOpen}
        className={`lg:hidden fixed top-0 right-0 bottom-0 z-20 w-[85%] max-w-sm bg-white/95 backdrop-blur-xl shadow-2xl transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          menuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full pt-24 px-8 pb-8">
          <div className="flex flex-col gap-1">
            {navLinks.map((link, i) => {
              const isActive = link.href.startsWith('#') && activeSection === link.href.slice(1);
              return (
                <a
                  key={link.href}
                  ref={i === 0 ? firstDrawerLinkRef : undefined}
                  href={link.href}
                  {...(!link.href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  onClick={() => setMenuOpen(false)}
                  aria-current={isActive ? 'true' : undefined}
                  className={`text-2xl py-4 border-b border-[#1f2a1d]/10 transition-all duration-500 ${
                    isActive ? 'font-semibold text-[#1f2a1d]' : 'font-medium text-[#4b5b47]'
                  } ${menuOpen ? 'translate-x-0 opacity-100' : 'translate-x-8 opacity-0'}`}
                  style={{ transitionDelay: menuOpen ? `${150 + i * 70}ms` : '0ms' }}
                >
                  {link.label}
                </a>
              );
            })}
          </div>

          <div
            className={`mt-8 flex flex-col gap-4 transition-all duration-500 ${
              menuOpen ? 'translate-x-0 opacity-100' : 'translate-x-8 opacity-0'
            }`}
            style={{ transitionDelay: menuOpen ? '400ms' : '0ms' }}
          >
            <a
              href="https://github.com/saiteja05/mongo-claude-memory"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm font-medium text-[#2d3a2a] sm:hidden"
            >
              <Star className="w-4 h-4" />
              Star on GitHub
            </a>
            <a
              href="https://github.com/saiteja05/mongo-claude-memory#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm font-medium text-[#2d3a2a] sm:hidden"
            >
              <BookOpen className="w-4 h-4" />
              Docs
            </a>
            <a
              href="https://github.com/saiteja05/mongo-claude-memory#quick-start"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 bg-[#1f2a1d] hover:bg-[#2a3827] text-white text-sm font-semibold px-5 py-3 rounded-full transition-colors"
            >
              Install
            </a>
          </div>
        </div>
      </div>

      <div className="relative z-10 flex flex-col items-center text-center pt-24 sm:pt-28 md:pt-32 px-4 sm:px-6">
        <motion.div {...heroEntrance(0)} className="mb-3 sm:mb-4">
          <span className="text-[#4b5b47] text-xs sm:text-sm font-semibold uppercase tracking-[0.2em]">
            Persistent memory for Claude Code
          </span>
        </motion.div>
        <motion.div {...heroEntrance(0.08)}>
          <h1
            className="font-normal leading-[0.95] text-[#336443] text-[2rem] sm:text-4xl md:text-5xl lg:text-[4.75rem] xl:text-[5.25rem] max-w-5xl"
            style={{ fontFamily: '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif', letterSpacing: '-0.035em' }}
          >
            Memory that{' '}
            <span className="text-[#85AB8B]">
              survives
              <br className="hidden sm:block" /> every compaction
            </span>
          </h1>
        </motion.div>
        <motion.div {...heroEntrance(0.16)} className="mt-4 sm:mt-5">
          <a
            href="https://www.mongodb.com/resources/basics/artificial-intelligence/agent-memory"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white/80 backdrop-blur-md rounded-full border border-[#00684A]/25 px-4 py-1.5 shadow-sm hover:bg-white/95 transition-colors"
          >
            <Leaf className="w-4 h-4 text-[#00684A]" />
            <span className="text-sm font-semibold text-[#00684A]">
              Powered by MongoDB Atlas
            </span>
          </a>
        </motion.div>
        <motion.div {...heroEntrance(0.24)} className="mt-6 sm:mt-8">
          <p className="text-[#4b5b47] text-sm sm:text-base md:text-lg leading-relaxed max-w-md px-2">
            Captures everything Claude Code sees, distills it offline, and hands it back as a small brief every session.
          </p>
        </motion.div>
        <motion.div {...heroEntrance(0.32)} className="mt-6 sm:mt-8">
          <a
            href="#get-started"
            className="inline-flex items-center bg-[#1f2a1d] hover:bg-[#2a3827] text-white text-sm font-medium px-5 py-2.5 rounded-full transition-colors"
          >
            Get started
          </a>
        </motion.div>
      </div>

      <div className="absolute left-4 right-4 sm:right-auto sm:left-6 md:left-10 bottom-6 sm:bottom-8 md:bottom-10 z-10 max-w-sm">
        <div className="rounded-2xl bg-[#1f2a1d]/45 backdrop-blur-sm px-5 py-4">
          <div className="flex items-center gap-2 text-white mb-3">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-semibold sm:font-medium">
              Recall engine
            </span>
          </div>
          <p className="text-white/85 text-xs leading-relaxed mb-6 max-w-xs font-medium sm:font-normal">
            One Atlas cluster does the work of a database, a vector store, a search engine, and a lock service. Nothing extra to wire up.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <a
              href="https://github.com/saiteja05/mongo-claude-memory#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="bg-[#3d5638] sm:bg-white hover:bg-[#2d4228] sm:hover:bg-white/90 text-white sm:text-[#1f2a1d] text-sm font-semibold px-5 sm:px-6 py-2.5 sm:py-3 rounded-full transition-colors shadow-sm"
            >
              Read the docs
            </a>
            <a
              href="#architecture"
              className="text-white text-sm font-semibold sm:font-medium hover:underline"
            >
              View architecture
            </a>
          </div>
        </div>
      </div>

      <a
        href="#how-it-works"
        className="hidden sm:flex absolute right-6 md:right-10 bottom-8 md:bottom-10 z-10 items-center gap-2 text-white/90 text-sm"
      >
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30 transition-colors">
          <Play className="w-3 h-3 fill-white text-white ml-0.5" />
        </span>
        <span className="font-medium">How to use it</span>
      </a>
    </section>
    <ArchitectureSection />
    <HowItWorksVisual />
    <BenchmarkSection />
    <LiveDemoSection />
    <ClosingCta />
    <Footer />
    </>
  );
}

export default App;
