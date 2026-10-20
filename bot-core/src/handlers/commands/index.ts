import type { CommandRegistry } from "../../router/commands.js";
import type { RuntimeState } from "../../state/runtime.js";
import type {
  ComplaintStore,
  DuelWinStore,
  KarmaStore,
  RemindersStore,
  SeenActivityStore,
  SentimentStore,
  SiestaDisciplineStore,
  SuggestionStore,
  TellStore,
  TriviaScoreStore,
  UserMemoryStore,
} from "../../state/repos.js";
import { roast } from "./roast.js";
import { jokes } from "./jokes.js";
import { help } from "./help.js";
import { status } from "./status.js";
import { weather } from "./weather.js";
import { meteo } from "./meteo.js";
import { fact } from "./fact.js";
import { eightball } from "./eightball.js";
import { quote } from "./quote.js";
import { makeSiesta } from "./siesta.js";
import { makeComplain } from "./complain.js";
import { makeSuggest } from "./suggest.js";
import { makeScore } from "./score.js";
import { makeTopNegative, makeTopPositive } from "./top.js";
import { makeTorture } from "./torture.js";
import { makeInsults } from "./insults.js";
import { makeAsk, models } from "./ask.js";
import { makeAsUser } from "./asuser.js";
import { makeProfile } from "./profile.js";
import { makeSeen } from "./seen.js";
import { whoami } from "./whoami.js";
import { makeTell } from "./tell.js";
import { makeRemind } from "./remind.js";
import { makeKarma } from "./karma.js";
import { makeTranslate } from "./translate.js";
import { makeTldr } from "./tldr.js";
import { roll } from "./roll.js";
import { makeTrivia } from "./trivia.js";
import { paint } from "./paint.js";
import { film } from "./film.js";
import { makeInstaDelete } from "./instadelete.js";
import type { ProfileService } from "../profiles/service.js";
import type { ConfigController } from "../../config/controller.js";
import type { PetService } from "../../pets/service.js";
import { makePet } from "./pet.js";
import { makeServices } from "./services.js";
import type { AskQuotaStore } from "../../state/ask-quota.js";
import type { InteractionStore } from "../../state/interactions.js";
import { makeBilling } from "./billing.js";
import { cost } from "./cost.js";
import { makeMute } from "./mute.js";

export interface CommandDeps {
  runtime: RuntimeState;
  discipline: SiestaDisciplineStore;
  askQuota: AskQuotaStore;
  interactions: InteractionStore;
  sentiment: SentimentStore;
  complaints: ComplaintStore;
  suggestions: SuggestionStore;
  seenActivity: SeenActivityStore;
  tells: TellStore;
  karma: KarmaStore;
  reminders: RemindersStore;
  triviaScores: TriviaScoreStore;
  duelScores: DuelWinStore;
  userMemory: UserMemoryStore;
  profiler: ProfileService;
  settings: ConfigController;
  pets: PetService;
}

// The registry must implement every catalogue command.
export function buildCommandRegistry(deps: CommandDeps): CommandRegistry {
  return {
    roast,
    jokes,
    help,
    status,
    weather,
    meteo,
    fact,
    eightball,
    quote,
    siesta: makeSiesta(deps.runtime, deps.discipline),
    complain: makeComplain(deps.complaints),
    suggest: makeSuggest(deps.suggestions),
    score: makeScore(deps.sentiment, deps.seenActivity),
    top_positive: makeTopPositive(deps.sentiment),
    top_negative: makeTopNegative(deps.sentiment),
    torture: makeTorture(deps.runtime),
    insults: makeInsults(deps.runtime, deps.seenActivity),
    ask: makeAsk(deps.userMemory, deps.profiler, deps.askQuota),
    models,
    as_user: makeAsUser(deps.userMemory, deps.profiler),
    profile: makeProfile(deps.userMemory, deps.profiler),
    seen: makeSeen(deps.seenActivity),
    whoami,
    tell: makeTell(deps.tells, deps.seenActivity),
    remind: makeRemind(deps.reminders),
    karma: makeKarma(deps.karma, deps.seenActivity),
    translate: makeTranslate(deps.userMemory, deps.profiler),
    tldr: makeTldr(deps.userMemory, deps.profiler),
    roll,
    paint,
    film,
    trivia: makeTrivia(deps.runtime, deps.triviaScores, deps.duelScores, deps.interactions),
    instadelete: makeInstaDelete(deps.settings),
    services: makeServices(deps.settings),
    pet: makePet(deps.pets),
    billing: makeBilling(deps.interactions, deps.seenActivity),
    cost,
    mute: makeMute(deps.interactions, deps.seenActivity),
  };
}
