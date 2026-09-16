# app/commands/roast.py
import random
import re
import unicodedata


class RoastCommand:
    """Sends ONE light-hearted, PG roast, themed by the named target. Single message, no flooding."""

    GENERIC_ROASTS = [
        "you bring everyone so much joy… when you leave the room.",
        "you're proof that even autocorrect gives up sometimes.",
        "you've got a face only a mother could debug.",
        "you're not lazy, you're just on energy-saving mode 24/7.",
        "if brains were bandwidth, you'd still be on dial-up.",
        "you're the human version of a 'reply all' email.",
        "you're like a cloud — when you disappear, it's a beautiful day.",
        "you bring a lot to the table… mostly your elbows.",
        "you're not the sharpest tool, but you're definitely in the shed.",
        "you're the reason the shampoo bottle has instructions.",
        "you're like Monday — nobody's happy to see you, but here we are.",
        "you're proof that evolution can take a coffee break.",
        "you're the WiFi at a cheap hotel: weak, unreliable, and everywhere I don't want you.",
        "you're like a software update: whenever I see you, I think 'not now'.",
    ]

    SINGAPORE_ROASTS = [
        "you're kiasu about everything except being interesting, lah.",
        "you're like the durian of this chat: strong presence, and half of us want the window open.",
        "you queue two hours for hype but zero minutes for a good personality.",
        "even the MRT breakdown apologises more sincerely than you do.",
        "you're proof Singapore is a fine city — every time you talk, I want to charge a fine.",
        "your chili crab energy is all shell, no meat.",
        "you can't even handle level-1 spicy at the hawker centre, let alone this roast.",
        "you're like the Merlion: mostly spitting, doing nothing useful.",
        "you're kaya on the outside, empty toast on the inside.",
        "you complain about the humidity, but you're the one making everything sweat.",
    ]

    ARGENTINA_ROASTS = [
        "you're like Argentine inflation — always going up, delivering less every day, che.",
        "you take longer than an asado and still come out undercooked.",
        "you insist you invented everything, boludo, including this argument you're losing.",
        "your mate is bitter, but not as bitter as you after losing at truco.",
        "you've got the confidence of Maradona and the skill of a folding chair.",
        "you'd need three therapists just to process how average that take was.",
        "you talk like you're from Buenos Aires and think like you're offside.",
        "you're all tango drama and zero footwork.",
        "you spread yourself thin like dulce de leche on stale bread.",
        "even Messi couldn't assist you out of this personality.",
    ]

    FRANCE_ROASTS = [
        "you're like a French strike: unannounced, inconvenient, and somehow proud of it.",
        "you have the aroma of a fine cheese and the charm of one too.",
        "you're all baguette — crusty outside, air inside.",
        "you say 'bof' to everything because effort scares you.",
        "you're like a week-old croissant: flaky and disappointing.",
        "you sip wine like a critic but review everything you've never understood.",
        "you'd rather philosophise about the problem than ever fix it.",
        "you bring the energy of a Parisian waiter who's decided he hates you.",
        "you're romantic in theory and a bureaucratic form in practice.",
        "you complain like it's an Olympic sport and you're going for gold.",
    ]

    FRANCE_COMPLIMENTS = [
        "you've got the effortless charm of a Parisian café on a sunny morning.",
        "you're as warm and comforting as a fresh croissant straight from the oven.",
        "you bring people together like a good bottle of Bordeaux over dinner.",
        "you have the timeless elegance of a stroll along the Seine.",
        "you're as rich and delightful as the best crème brûlée.",
        "you make even ordinary moments feel like a scene from a French film.",
        "you've got great taste — the kind that turns a picnic into a celebration.",
        "you're proof that joie de vivre is a real superpower.",
        "you handle life with the calm confidence of a master sommelier.",
        "you light up the room like the Eiffel Tower at midnight.",
    ]

    def get_required_context(self):
        return []

    def execute(self, config, message_text, context):
        is_negative = bool(re.search(r"(?i)bot\.roast\.neg\b", str(message_text or "")))
        target = self._extract_target(message_text)
        norm = self._normalize(target)
        tokens = norm.split()
        is_baptiste = "baptis" in norm

        # Baptiste is complimented by default; bot.roast.neg gives the classic roast instead.
        if is_baptiste and not is_negative:
            line = random.choice(self.FRANCE_COMPLIMENTS)
            return f"💙 {target or 'Baptiste'}, {line}"

        roasts = self._roasts_for_target(norm, tokens)
        roast = random.choice(roasts)
        if target:
            return f"🔥 {target}, {roast}"
        return f"🔥 {roast.capitalize()}"

    def _roasts_for_target(self, norm, tokens):
        # Match 'Si Ying', 'SiYing', or a standalone 'Si' (but not 'Simon', 'Sister', etc.).
        if "si ying" in norm or "siying" in norm or "si" in tokens:
            return self.SINGAPORE_ROASTS
        if "hernan" in norm:
            return self.ARGENTINA_ROASTS
        if "baptis" in norm:
            return self.FRANCE_ROASTS
        return self.GENERIC_ROASTS

    def _normalize(self, name):
        text = unicodedata.normalize("NFKD", str(name or ""))
        text = "".join(c for c in text if not unicodedata.combining(c))
        return text.strip().casefold()

    def _extract_target(self, message_text):
        text = re.sub(r"\s+\d{1,2}:\d{2}\s*$", "", str(message_text or "")).strip()
        match = re.search(r"(?i)bot\.roast(?:\.neg)?\b\s*(.*)$", text)
        return match.group(1).strip() if match else ""
