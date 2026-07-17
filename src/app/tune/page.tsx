import { Tune, type TuneActions } from "@/components/tune";
import {
  decideSuggestionAction,
  loadTuneView,
  startTuneAction,
} from "./actions";

/**
 * "/tune" — Optimize.
 *
 * An RSC that reads the current tune state server-side (the latest run's
 * metadata, or a live query-log snapshot when none has run) and hands the
 * client component the three server actions it drives. Passing the actions as
 * props — rather than importing them in the component — keeps dependencies
 * pointing app → components → lib and keeps Trigger credentials off the client.
 */
export const dynamic = "force-dynamic";

const actions: TuneActions = {
  start: startTuneAction,
  refresh: loadTuneView,
  decide: decideSuggestionAction,
};

export default async function TunePage() {
  const initial = await loadTuneView();
  return <Tune initial={initial} actions={actions} />;
}
