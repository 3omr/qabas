/**
 * Order a provider's models the way a student chooses: the newest main models
 * first, special-purpose ones (previews, lite, image, live, research) after.
 * Catalogs arrive alphabetical, which puts a provider's retired models on top.
 */

/**
 * Ids of models that are not a general writing model, or not a stable one.
 * Gemma is listed too: a small open model writes far shorter answers than the
 * provider's main line, and its higher version number would otherwise put it
 * on top of the suggestions.
 */
const SPECIAL = /preview|lite|live|image|computer-use|deep-research|customtools|embedding|tts|audio|banana|gemma/iu

/**
 * Whether a model is special-purpose rather than a main model.
 * @param id - model id.
 * @param name - display name.
 * @returns true for previews, lite, image and other special models.
 */
export function isSpecialModel(id: string, name = ''): boolean {
  return SPECIAL.test(id) || SPECIAL.test(name)
}

/**
 * The model's version as written in its id ("gemini-3.8-flash" → 3.8).
 * @param id - model id.
 * @returns the version, or 0 when the id carries none.
 */
export function modelVersion(id: string): number {
  const match = /(?:^|[-_])(\d+(?:\.\d+)?)(?=[-_]|$)/u.exec(id)
  return match === null ? 0 : Number(match[1])
}

/**
 * Split and order one provider's models.
 * @param models - the provider's catalog entries.
 * @returns main models newest first, then special models newest first.
 */
export function rankModels<M extends { readonly id: string; readonly name: string }>(
  models: readonly M[],
): { readonly main: readonly M[]; readonly special: readonly M[] } {
  const newest = (left: M, right: M): number => modelVersion(right.id) - modelVersion(left.id)
  return {
    main: models.filter(model => !isSpecialModel(model.id, model.name)).toSorted(newest),
    special: models.filter(model => isSpecialModel(model.id, model.name)).toSorted(newest),
  }
}
