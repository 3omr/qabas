"""Synthetic papers reproducing the toxo Salycylates question-selection failure."""

EVIDENCE = (
    "Salicylates: aspirin is acetylsalicylic acid. Aspirin overdose causes respiratory alkalosis, then metabolic acidosis. "
    "Death from aspirin follows renal failure, coma and respiratory failure. Gastric lavage for aspirin within hours. "
    "Salicylates toxicity: aspirin level, metabolic acidosis, renal failure."
)


def questions():
    dated = {
        "death": {"stem": "Cause of death in aspirin........", "options": {
            "a": "Respiratory failure", "b": "Metabolic acidosis", "c": "Coma", "d": "Renal failure"},
            "years": [2022], "sources": ["End Toxico 2023.pdf"]},
        "toxicity": {"stem": "3) As regarding aspirin toxicity:-", "options": {
            "a": "Salicylates cause metabolic acidosis", "b": "Gastric lavage is used",
            "c": "Aspirin may cause coma", "d": "Respiratory alkalosis occurs"},
            "years": [2025], "sources": ["End 2025.pdf"]},
    }
    off_topic = {poison: {"stem": f"{poison} poisoning", "options": {
        "a": "Gastric lavage", "b": "Coma", "c": "Metabolic acidosis", "d": "Respiratory failure"},
        "years": [2025], "sources": ["Other 2025.txt"]}
        for poison in ("Cathartics", "Carbon monoxide", "Corrosives", "Opium")}
    # A realistic module bank: aspirin is one topic among many, as in the toxo bank (about 12%).
    bank = {f"bank-{number:02}": {"stem": f"Aspirin salicylates assessment {chr(97 + number // 26)}{chr(97 + number % 26)}",
        "options": {"a": "Aspirin salicylates", "b": "Gastric lavage", "c": "Coma", "d": "Metabolic acidosis"},
        "years": [], "sources": ["Bank.txt"]} for number in range(55)}
    other_topics = {f"other-{number:03}": {"stem": f"{topic} question {number}", "options": {
        "a": f"{topic} finding", "b": "Gastric lavage", "c": "Coma", "d": "Supportive care"},
        "years": [], "sources": ["Bank.txt"]}
        for number, topic in enumerate(("Lead", "Arsenic", "Mercury", "Methanol", "Ethanol", "Cyanide", "Snake", "Scorpion",
                                        "Cannabis", "Morphine", "Botulism", "Paraquat") * 30)}
    return {**dated, **off_topic, **bank, **other_topics}
