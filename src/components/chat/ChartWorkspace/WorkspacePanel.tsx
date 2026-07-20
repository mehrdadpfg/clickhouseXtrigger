"use client";

import { useEffect, useRef, useState } from "react";
import { useAuiState, useThreadRuntime } from "@assistant-ui/react";
import { ArrowUp, Eye, LayoutDashboard } from "lucide-react";
import {
  asChartSpec,
  chartSpan,
  ExportMenu,
  slugify,
  Tooltip,
} from "@/components/ui";
import {
  getMaxDate,
  getSchemaNamespace,
  runWorkspaceQuery,
} from "@/app/chats/actions";
import { ChartStudio, type StudioSlot } from "@/components/shared/ChartStudio";
import { recast, TABLE_VIEW } from "@/components/shared/ChartType";
import { BoardPickerModal } from "../AgentTurn/BoardPickerModal";
import { markUiAction } from "../uiAction";
import { useWorkspace } from "./WorkspaceProvider";
import styles from "./ChartWorkspace.module.css";

/**
 * The chat's home for {@link ChartStudio}: a floating canvas that pushes the
 * thread aside rather than covering it. The studio owns the chart, the editor,
 * and every result; this panel owns the shell it floats in and the behaviour
 * that only the chat has.
 *
 * That behaviour is one idea — interactions leave by a single door. A clicked
 * mark, a brushed range, or a typed question all append plain language to the
 * thread and let the agent re-derive the SQL from the turn it already wrote, so
 * there is nothing to keep in sync. The canvas stays open while the answer
 * streams in behind it and takes itself over onto the drill's answer, which is
 * what makes drilling a loop rather than a round trip.
 */
export function WorkspacePanel() {
  const { current, isOpen, close, open, expectDrill, drillPending, clearDrill } =
    useWorkspace();
  const thread = useThreadRuntime();

  const [pinning, setPinning] = useState(false);
  // Captured when Pin is pressed rather than read live: the modal is a sibling
  // of the studio, so it can't reach the studio's view state when it renders.
  const [pinView, setPinView] = useState("");
  const [question, setQuestion] = useState("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
  // Loaded once per mount, not per chart: the namespace is the same for every
  // chart in the thread, and it is cached server-side besides.
  const [schema, setSchema] = useState<
    Record<string, Record<string, string[]>> | undefined
  >();

  const currentId = current?.id ?? null;
  const spec = current?.spec ?? null;

  useEffect(() => {
    let live = true;
    void getSchemaNamespace().then((ns) => {
      if (live) setSchema(ns);
    });
    return () => {
      live = false;
    };
  }, []);

  // The studio remounts per chart (keyed below), so its own state resets itself;
  // these two are the panel's, so the panel clears them when the chart changes.
  useEffect(() => {
    setQuestion("");
    setPinning(false);
  }, [currentId]);

  // Grow with the text rather than scrolling a two-line box: these are one-line
  // requests most of the time, but a reader spelling out a comparison shouldn't
  // have to write it through a slot.
  useEffect(() => {
    const box = questionRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
  }, [question]);

  // Esc closes. The shell is a push panel, not a Radix dialog, so this is ours
  // to wire — along with leaving the thread focusable, which is the point.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  const ask = (question: string) => thread.append(question);

  /**
   * The last chart of the last assistant turn, and whether the thread is idle.
   *
   * Read from the thread rather than having each tile offer itself on mount:
   * mount order is not answer order — a chart re-mounting from elsewhere in the
   * conversation would claim a pending drill, which is exactly what happened
   * (a taxi chart from another turn took the canvas after a borough drill).
   * The last renderChart of the newest assistant message is unambiguous.
   */
  const newestChartId = useAuiState((state) => {
    const messages = state.thread.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const parts = message.content ?? [];
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const part = parts[j] as {
          type?: string;
          toolName?: string;
          toolCallId?: string;
        };
        if (part?.type === "tool-call" && part.toolName === "renderChart") {
          return part.toolCallId ?? null;
        }
      }
      break;
    }
    return null;
  });
  const threadBusy = useAuiState((state) => state.thread.isRunning);

  useEffect(() => {
    if (threadBusy || !newestChartId || !drillPending()) return;
    if (newestChartId === currentId) return;

    // The args are read imperatively rather than selected: a selector returning
    // the parsed spec would build a new object every render, and useAuiState
    // compares snapshots by identity — that loops until React gives up.
    const messages = thread.getState().messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      for (const raw of message.content ?? []) {
        const part = raw as { toolCallId?: string; args?: unknown };
        if (part.toolCallId !== newestChartId) continue;
        const drilled = asChartSpec(part.args);
        if (!drilled) return;
        clearDrill();
        open({ id: newestChartId, spec: drilled, view: "" });
        return;
      }
      break;
    }
  }, [threadBusy, newestChartId, currentId, drillPending, clearDrill, open, thread]);

  /**
   * Clicking a mark asks the agent to break that category down one level finer.
   *
   * The intent goes as plain language, not a structured predicate: the agent
   * re-derives the SQL from the chart's own query, which the chart now carries,
   * so there is nothing to keep in sync. It is deliberately not told WHICH column
   * to split by — nothing in this codebase holds a dimension hierarchy, and the
   * agent can pick a sensible next level from the schema at click time.
   *
   * The canvas stays open: the answer arrives as a new turn behind it, so
   * drilling twice in a row doesn't mean re-opening the chart each time.
   */
  const drillInto = (category: string) => {
    if (!spec) return;
    // Claim the next chart: the canvas should end up on the answer, not still
    // showing the thing that was clicked.
    expectDrill();
    ask(
      markUiAction(
        category,
        `In the chart "${spec.title}", break down "${category}" one level finer — ` +
          `keep the same measure, and split it by whichever dimension explains ` +
          `the most about that group. Chart the result.`,
      ),
    );
  };

  /**
   * A brushed range asks what drove the shape over that span. Same exit as a
   * click — plain language, the agent re-derives the SQL from the chart's own
   * query — so the two interactions stay one mechanism rather than two.
   */
  const explainRange = (from: string, to: string) => {
    if (!spec) return;
    expectDrill();
    const span = from === to ? from : `${from} to ${to}`;
    ask(
      markUiAction(
        span,
        `In the chart "${spec.title}", something happened between ${from} and ${to}. ` +
          `Investigate that window specifically — compare it against the surrounding ` +
          `periods and name what drove the difference, with the numbers. Chart the evidence.`,
      ),
    );
  };

  /**
   * The typed version of the same interaction: instead of clicking a mark, the
   * reader says what they want changed about the chart in front of them.
   *
   * It leaves by the one door the click interactions use — plain language naming
   * the chart, appended to the thread — because the agent still holds the turn it
   * drew this chart from and can re-derive the query. The only thing it cannot
   * know is a query the reader edited HERE AND RAN, so that one rides along (the
   * studio hands it over as `editedRanSql`); the canvas would otherwise be
   * answered about a chart it is no longer showing.
   *
   * Deliberately NOT markUiAction, unlike every other exit from this panel. That
   * channel hides the message and shows a short label instead, on the grounds
   * that "the reader never wrote those words" — here they did, and a sentence in
   * the label slot renders as a one-word chip and truncates at the first "] ".
   * So this is a real user bubble, and everything in it is phrased as something
   * the reader could have written, because it is shown to them as their own.
   */
  const askAboutChart = (editedRanSql: string | null) => {
    const asked = question.trim();
    if (!spec || asked === "" || threadBusy) return;
    expectDrill();
    setQuestion("");
    ask(
      `About the chart "${spec.title}": ${asked}\n\n` +
        (editedRanSql
          ? `I edited its query in the panel and ran it — this is what is on screen ` +
            `now, so work from this:\n\n${editedRanSql}\n\n`
          : `Work from that chart's own query and change only what I asked for. `) +
        `Chart the result.`,
    );
  };

  return (
    <aside
      className={`${styles.panel} ${isOpen ? styles.panelOpen : ""}`}
      aria-hidden={!isOpen}
    >
      <div className={styles.inner}>
        <div className={styles.surface}>
          <ChartStudio
            // A different chart is a fresh mount: the studio re-seeds its editor
            // and clears its results without any reset wiring here.
            key={currentId ?? "empty"}
            spec={spec}
            onRun={(sql) => runWorkspaceQuery(sql)}
            {...(schema ? { schema } : {})}
            resolveMaxDate={getMaxDate}
            onPick={drillInto}
            onBrush={explainRange}
            actions={(slot: StudioSlot) => (
              <>
                <button
                  type="button"
                  className={slot.buttonClass}
                  onClick={() =>
                    spec &&
                    ask(
                      markUiAction(
                        "Watch",
                        `Set up a watcher on "${spec.title}". Ask me which number from this chart to watch and what threshold should trip it before you create it.`,
                      ),
                    )
                  }
                >
                  <Eye size={14} strokeWidth={2} aria-hidden="true" />
                  Watch
                </button>
                {!slot.showingTable && spec ? (
                  <ExportMenu
                    chartRef={slot.chartRef}
                    filename={slugify(spec.title)}
                    buttonClassName={slot.buttonClass}
                  />
                ) : null}
                <Tooltip label="Add this chart to a dashboard">
                  <button
                    type="button"
                    className={slot.buttonClass}
                    onClick={() => {
                      setPinView(slot.view);
                      setPinning(true);
                    }}
                    disabled={!spec?.sql}
                  >
                    <LayoutDashboard
                      size={14}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    Pin
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className={styles.close}
                  onClick={close}
                  aria-label="Close the workspace"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </>
            )}
            footer={(slot: StudioSlot) =>
              spec ? (
                <form
                  className={styles.composer}
                  onSubmit={(e) => {
                    e.preventDefault();
                    askAboutChart(slot.editedRanSql);
                  }}
                >
                  <textarea
                    ref={questionRef}
                    className={styles.composerBox}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        askAboutChart(slot.editedRanSql);
                      }
                      // Esc closes the canvas from anywhere else, which would
                      // throw away a half-written question; here it clears the
                      // box first.
                      if (e.key === "Escape" && question !== "") {
                        e.stopPropagation();
                        setQuestion("");
                      }
                    }}
                    placeholder="Ask for a change to this chart…"
                    aria-label="Ask for a change to this chart"
                    rows={1}
                  />
                  <button
                    type="submit"
                    className={styles.composerSend}
                    disabled={question.trim() === "" || threadBusy}
                  >
                    <ArrowUp size={13} strokeWidth={2.5} aria-hidden="true" />
                    {threadBusy ? "Answering…" : "Ask"}
                  </button>
                </form>
              ) : null
            }
          />
        </div>
      </div>

      {/* Pins the chart AS VIEWED — the reader may have recast it, and the tile
          they get should be the one they were looking at. Span doubling matches
          AnswerActions: the chat is a 2-col grid, a board is 4. */}
      {pinning && spec?.sql ? (
        <BoardPickerModal
          open={pinning}
          onClose={() => setPinning(false)}
          charts={[
            {
              title: spec.title || "Chart",
              sql: spec.sql,
              spec: {
                chartType:
                  pinView && pinView !== TABLE_VIEW ? pinView : spec.chartType,
                encodings:
                  pinView && pinView !== TABLE_VIEW && pinView !== spec.chartType
                    ? recast(spec, pinView).encodings
                    : spec.encodings,
                ...(spec.horizontal ? { horizontal: true } : {}),
                ...(spec.semanticTypes
                  ? { semanticTypes: spec.semanticTypes }
                  : {}),
                span: Math.min(chartSpan(spec) * 2, 4),
              },
            },
          ]}
        />
      ) : null}
    </aside>
  );
}
