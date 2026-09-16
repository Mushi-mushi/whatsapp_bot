import type { Handler } from "../../router/router.js";
import type { RuntimeState } from "../../state/runtime.js";
import type {
  ComplaintStore,
  KarmaStore,
  RemindersStore,
  SeenActivityStore,
  SentimentStore,
  TellStore,
  TriviaScoreStore,
} from "../../state/repos.js";
import { roast } from "./roast.js";
import { jokes } from "./jokes.js";
import { help } from "./help.js";
import { status } from "./status.js";
import { weather } from "./weather.js";
import { fact } from "./fact.js";
import { eightball } from "./eightball.js";
import { quote } from "./quote.js";
import { makeSiesta } from "./siesta.js";
import { makeComplain } from "./complain.js";
import { makeScore } from "./score.js";
import { makeTopNegative, makeTopPositive } from "./top.js";
import { makeTorture } from "./torture.js";
import { makeInsults } from "./insults.js";
import { ask } from "./ask.js";
import { makeSeen } from "./seen.js";
import { makeTell } from "./tell.js";
import { makeRemind } from "./remind.js";
import { makeKarma } from "./karma.js";
import { translate } from "./translate.js";
import { tldr } from "./tldr.js";
import { roll } from "./roll.js";
import { makeTrivia } from "./trivia.js";

export interface CommandDeps {
  runtime: RuntimeState;
  sentiment: SentimentStore;
  complaints: ComplaintStore;
  seenActivity: SeenActivityStore;
  tells: TellStore;
  karma: KarmaStore;
  reminders: RemindersStore;
  triviaScores: TriviaScoreStore;
}

// Command name (config value) -> handler. Add new commands here.
export function buildCommandRegistry(deps: CommandDeps): Record<string, Handler> {
  return {
    roast,
    jokes,
    help,
    status,
    weather,
    fact,
    eightball,
    quote,
    siesta: makeSiesta(deps.runtime),
    complain: makeComplain(deps.complaints),
    score: makeScore(deps.sentiment),
    top_positive: makeTopPositive(deps.sentiment),
    top_negative: makeTopNegative(deps.sentiment),
    torture: makeTorture(deps.runtime),
    insults: makeInsults(deps.runtime),
    ask,
    seen: makeSeen(deps.seenActivity),
    tell: makeTell(deps.tells),
    remind: makeRemind(deps.reminders),
    karma: makeKarma(deps.karma),
    translate,
    tldr,
    roll,
    trivia: makeTrivia(deps.runtime, deps.triviaScores),
  };
}
