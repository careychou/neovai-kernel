/** Model ids: models of every provider after the first are written `<providerId>::<model>`; the first provider's stay bare. */
export const SEP = '::'
export const qualify = (providerId: string, model: string) => `${providerId}${SEP}${model}`
export function splitModel(model: string): { provider: string | null; model: string } {
  const i = model.indexOf(SEP)
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + SEP.length) } : { provider: null, model }
}
/** Keeps the provider prefix of the requested id but names the model that actually served it. */
export function servedModel(requested: string, served?: string): string {
  if (!served) return requested
  const { provider } = splitModel(requested)
  return provider ? qualify(provider, served) : served
}
