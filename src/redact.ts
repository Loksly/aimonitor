/**
 * Tapado de secretos para lo que se pinta en el panel.
 *
 * Vive aparte de `hook.ts` porque ese fichero es un ejecutable que lee de la
 * entrada estándar: importarlo desde una prueba se queda esperando para
 * siempre.
 */
/**
 * Secretos que no deben acabar en la pantalla.
 *
 * `detail` lleva el comando tal cual, y el panel es un monitor de 9 pulgadas
 * que ve cualquiera que pase por delante. Un `curl` con una URL de calendario
 * publicada, una variable con un token o un `Authorization:` se pintarían
 * enteros. Además el registro se guarda en disco, así que el secreto sobrevive
 * al comando.
 *
 * La lista es deliberadamente corta y específica: tapar de más convierte los
 * mensajes en ruido y quita al panel su razón de ser, que es que se lea de un
 * vistazo qué está haciendo cada consola.
 */
const SECRETS: [RegExp, string][] = [
  // Direcciones secretas de Google Calendar y similares.
  [/private-[0-9a-f]{16,}/gi, 'private-<oculto>'],
  // Credenciales dentro de una URL.
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<oculto>@'],
  // Cabeceras y parámetros con nombre revelador. La de `Authorization` se trata
  // aparte y consume dos palabras: con un solo `\S+` se tapaba el «Bearer» y
  // el token seguía a la vista, que es exactamente el fallo que no se puede
  // cometer aquí.
  [/\b(authorization)\s*:\s*(?:\S+[ \t]+)?\S+/gi, '$1: <oculto>'],
  [/\bbearer[ \t]+\S+/gi, 'Bearer <oculto>'],
  [/\b(api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd)\b(\s*[=:]\s*)\S+/gi, '$1$2<oculto>'],
  // Formatos de token reconocibles a simple vista.
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '<oculto>'],
];

export function redact(text: string): string {
  return SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

