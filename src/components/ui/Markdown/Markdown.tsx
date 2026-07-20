"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * The agent's prose, rendered as real markdown.
 *
 * This replaces a hand-rolled inline pass that handled **bold**, *italic* and
 * `code` and nothing else, with the whole message dropped into a single <p>.
 * Its docstring justified itself with "the answers are one or two sentences
 * now, so a full markdown engine would be more than the text needs" — which
 * stopped being true. The agent writes headings, numbered lists, tables and
 * fenced SQL, and all of it collapsed into one run-on paragraph with the
 * syntax showing through as literal asterisks.
 *
 * remark is the parser rather than a regex because the failure mode of a naive
 * one is not "some markdown is missed" but "the pairing breaks and the syntax
 * leaks into the reader's face": the old TOKEN regex matched `**[^*]+**`, so a
 * single stray asterisk anywhere in a long answer desynchronised every bold
 * span after it.
 *
 * Raw HTML is NOT enabled. react-markdown ignores it by default and that
 * default is load-bearing here — this text is model output, and the one thing
 * it must never be able to do is inject markup into the page.
 *
 * Safe to render mid-stream: a partial document simply parses as less markdown
 * (an unterminated fence is a paragraph until its closing ``` arrives), so the
 * text reflows as it lands rather than erroring.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("md", className)}>
      <ReactMarkdown
        // GFM is what the agent actually writes: tables for comparisons,
        // strikethrough, task lists, and bare URLs it expects to be linked.
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings step down in size but never below body weight — an agent
          // answer is a note, not a document, so an h1 inside a chat bubble
          // should not shout at the reader.
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-[15px] font-semibold tracking-[-0.01em] text-[var(--text)] first:mt-0 [text-wrap:balance]">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--text)] first:mt-0 [text-wrap:balance]">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3.5 text-[13.5px] font-semibold text-[var(--text)] first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-[1.65] first:mt-0 last:mb-0 [text-wrap:pretty]">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5 marker:text-[var(--text-faint)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-[var(--text-faint)] marker:tabular-nums">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-[1.6] [text-wrap:pretty]">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-[var(--text)]">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline decoration-[var(--border-accent)] underline-offset-2 hover:decoration-current"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2.5 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-0 border-t border-[var(--border-subtle)]" />,
          // A fenced block is a <pre><code>; an inline span is a bare <code>.
          // react-markdown v10 no longer passes `inline`, so the two are told
          // apart by whether a <pre> is the parent — which is why `pre` below
          // renders no wrapper of its own and lets `code` own the whole box.
          pre: ({ children }) => <>{children}</>,
          code: ({ className: lang, children }) => {
            const text = String(children).replace(/\n$/, "");
            const fenced = /language-/.test(lang ?? "") || text.includes("\n");
            if (!fenced) {
              return (
                <code className="rounded-[4px] border border-border bg-[var(--raised)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--text)]">
                  {children}
                </code>
              );
            }
            return (
              <pre className="my-2.5 overflow-x-auto rounded-[var(--r-md)] border border-border bg-[var(--raised)] p-3">
                <code className="font-mono text-[12px] leading-[1.55] text-[var(--text-secondary)]">
                  {text}
                </code>
              </pre>
            );
          },
          // Tables scroll inside their own box: a wide comparison must not make
          // the whole reading column scroll sideways.
          table: ({ children }) => (
            <div className="my-2.5 overflow-x-auto rounded-[var(--r-md)] border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-[var(--raised)]">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-2.5 py-1.5 text-left font-mono text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-[var(--border-subtle)] px-2.5 py-1.5 align-top tabular-nums">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
