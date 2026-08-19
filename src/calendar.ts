/**
 * Próxima reunión del día, leída de un calendario ICS publicado.
 *
 * Microsoft 365 no expone CalDAV y en Linux no hay cliente de Teams con caché
 * local, así que la vía practicable es publicar el calendario desde Outlook Web
 * y leer ese `.ics`.
 *
 * El parseo se delega en `ical.js` (el de Mozilla, el que usa Thunderbird) y no
 * se hace a mano por dos razones que el propio fichero deja ver:
 *
 *   - Las horas vienen con `TZID` en nombres de zona de Windows
 *     ("Romance Standard Time"), y el fichero trae sus bloques `VTIMEZONE` con
 *     las reglas de horario de verano. Resolver eso a mano es donde aparecen
 *     los errores de una hora.
 *   - Hay reuniones recurrentes (`RRULE`) que hay que expandir: el *daily* de
 *     la mañana es justo una de ellas.
 *
 * Un fallo aquí no se ve como un fallo, se ve como una hora equivocada, que es
 * peor que no tener la función.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR, type Config } from './config.ts';
import type { Meeting } from './types.ts';

/** La URL responde, pero con algo que no es un calendario. */
class NotAnIcsFeed extends Error {}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Calendarios configurados. `icsUrl` admite una URL suelta o una lista, para no
 * romper las configuraciones que ya existían con una sola.
 *
 * Se quitan los repetidos: al pegar varias URLs a mano se cuela una dos veces
 * con facilidad, y cada copia sería una descarga entera y un pase de parseo
 * para acabar produciendo duplicados que luego hay que volver a descartar.
 */
export function icsUrls(cfg: Config): string[] {
  const raw = cfg.calendar.icsUrl;
  const lista = (Array.isArray(raw) ? raw : [raw]).map((u) => String(u).trim()).filter(Boolean);
  return [...new Set(lista)];
}

/**
 * Copia local de cada ICS, para sobrevivir a un corte de red.
 *
 * El nombre sale de la URL, no de un contador: así añadir o quitar calendarios
 * no reordena los ficheros ni deja a un feed leyendo la caché de otro.
 */
function cachePaths(url: string): { ics: string; etag: string } {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 12);
  return { ics: join(STATE_DIR, `calendar-${key}.ics`), etag: join(STATE_DIR, `calendar-${key}.etag`) };
}

/** La caché de una sola URL se llamaba `calendar.ics`; ya no la lee nadie. */
function dropLegacyCache(): void {
  for (const name of ['calendar.ics', 'calendar.etag']) {
    const path = join(STATE_DIR, name);
    // Es una copia de la agenda en disco: dejarla ahí muerta para siempre es
    // peor que borrarla, y se regenera sola con el nombre nuevo.
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/**
 * Descarga el ICS si ha cambiado. Son ~350 KB, así que se usa `ETag` para no
 * traerlo entero cada pocos minutos.
 */
export async function fetchIcs(cfg: Config, url: string): Promise<string | null> {
  if (!url) return null;
  const { ics: CACHE_PATH, etag: ETAG_PATH } = cachePaths(url);

  const cached = readIfExists(CACHE_PATH);
  const etag = readIfExists(ETAG_PATH);

  try {
    const res = await fetch(url, {
      headers: etag && cached ? { 'If-None-Match': etag } : {},
      signal: AbortSignal.timeout(cfg.calendar.timeoutMs),
    });
    if (res.status === 304 && cached) return cached;
    if (!res.ok) return cached;

    const body = await res.text();
    if (!body.includes('BEGIN:VCALENDAR')) {
      // Pegar el enlace de la interfaz web en vez del feed es el error natural:
      // Google devuelve su página con un 200 tan campante, así que sin esto la
      // función queda muerta y en silencio.
      throw new NotAnIcsFeed(
        /^\s*<(!doctype|html)/i.test(body)
          ? 'la URL devuelve una página web, no un calendario. Necesitas la «dirección secreta en formato iCal» ' +
            '(termina en `/basic.ics`), no el enlace del navegador.'
          : 'la respuesta no parece un calendario iCalendar (no contiene BEGIN:VCALENDAR).',
      );
    }

    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, body, { encoding: 'utf8', mode: 0o600 });
    const newEtag = res.headers.get('etag');
    if (newEtag) writeFileSync(ETAG_PATH, newEtag, { encoding: 'utf8', mode: 0o600 });
    return body;
  } catch (err) {
    // Una URL equivocada no es un corte de red: con la caché anterior taparía
    // el problema para siempre. Sube, y `fetchAll` lo cuenta.
    if (err instanceof NotAnIcsFeed) throw err;
    // Sin red sí se sigue con la última copia buena: las reuniones de hoy ya
    // estaban dentro.
    return cached;
  }
}

/** Un aviso por calendario roto, no uno cada cinco minutos. */
const warned = new Set<string>();

/**
 * Descarga todos los calendarios a la vez.
 *
 * Se usa `allSettled` y no `all` a propósito: con varias fuentes, que una esté
 * caída no puede dejarte sin las reuniones de las otras.
 */
export async function fetchAll(cfg: Config): Promise<string[]> {
  dropLegacyCache();
  const urls = icsUrls(cfg);
  const settled = await Promise.allSettled(urls.map((u) => fetchIcs(cfg, u)));
  const out: string[] = [];
  settled.forEach((r, i) => {
    const ics = r.status === 'fulfilled' ? r.value : null;
    if (ics) {
      warned.delete(urls[i]!);
      out.push(ics);
      return;
    }
    // La URL es un secreto portador: en el aviso va la posición, nunca la URL.
    const label = `calendario ${i + 1} de ${urls.length}`;
    const why = r.status === 'rejected' && r.reason instanceof Error ? `: ${r.reason.message}` : '';
    if (!warned.has(urls[i]!)) {
      warned.add(urls[i]!);
      console.warn(`Advertencia: no se pudo leer el ${label}${why}`);
    }
  });
  return out;
}

/**
 * `ical.js` es una dependencia **opcional**: sólo hace falta si se activa el
 * calendario. Se carga en diferido para que quien no use la función no pague ni
 * su tiempo de arranque ni su instalación, y para que el daemon siga
 * funcionando si el paquete no está.
 */
export type IcalModule = (typeof import('ical.js'))['default'];

let pending: Promise<IcalModule | null> | null = null;

export async function loadIcal(): Promise<IcalModule | null> {
  pending ??= import('ical.js')
    .then((m) => ((m as any).default ?? m) as IcalModule)
    .catch(() => null);
  return pending;
}

/** Registra las zonas que el propio fichero define. */
function registerTimezones(ICAL: IcalModule, comp: any): void {
  for (const vt of comp.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vt);
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vt);
  }
}

function ignored(summary: string, patterns: string[]): boolean {
  const s = summary.toLowerCase();
  return patterns.some((p) => p && s.includes(p.toLowerCase()));
}

/**
 * Reuniones que quedan hoy, en orden. Se descartan las que no reclaman nada:
 * eventos de todo el día, los marcados como libre u «fuera de la oficina», y
 * los que encajen con los patrones de la config (los bloques de concentración
 * de Outlook van marcados como ocupado y si no taparían el panel).
 */
export function parseMeetings(ICAL: IcalModule, ics: string, cfg: Config, now = Date.now()): Meeting[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(ICAL, comp);

  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);
  const endMs = dayEnd.getTime();
  const out: Meeting[] = [];

  for (const sub of comp.getAllSubcomponents('vevent')) {
    let ev: any;
    try {
      ev = new ICAL.Event(sub);
    } catch {
      continue; // un evento corrupto no debe tumbar el resto
    }
    if (!ev.startDate || ev.startDate.isDate) continue; // de todo el día

    const busy = String(sub.getFirstPropertyValue('x-microsoft-cdo-busystatus') ?? '');
    const transp = String(sub.getFirstPropertyValue('transp') ?? '');
    if (transp === 'TRANSPARENT' || busy === 'FREE' || busy === 'OOF') continue;

    const summary = ev.summary ?? '';
    if (ignored(summary, cfg.calendar.ignorePatterns)) continue;

    const isPrivate = String(sub.getFirstPropertyValue('class') ?? '') === 'PRIVATE';
    const add = (startMs: number, endMsEvent: number) => {
      // Interesa lo que aún no ha terminado: una reunión en curso sigue siendo
      // la que reclama.
      if (startMs > endMs || endMsEvent <= now) return;
      out.push({
        title: summary,
        startsAt: startMs,
        endsAt: endMsEvent,
        tentative: busy === 'TENTATIVE',
        private: isPrivate,
      });
    };

    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next: any;
      let guard = 0;
      // Tope de seguridad: una recurrencia mal formada podría iterar sin fin.
      while ((next = it.next()) && guard++ < 500) {
        if (next.toJSDate().getTime() > endMs) break;
        try {
          const d = ev.getOccurrenceDetails(next);
          add(d.startDate.toJSDate().getTime(), d.endDate.toJSDate().getTime());
        } catch {
          /* ocurrencia irresoluble: se salta */
        }
      }
    } else {
      add(ev.startDate.toJSDate().getTime(), ev.endDate?.toJSDate().getTime() ?? ev.startDate.toJSDate().getTime());
    }
  }

  out.sort((a, b) => a.startsAt - b.startsAt);
  return out;
}

/**
 * La siguiente reunión que queda hoy, o null.
 *
 * Sale por la puerta de atrás en cuanto el calendario está desactivado, que es
 * lo normal: así no se descarga nada, no se toca la red y `ical.js` ni siquiera
 * llega a cargarse.
 */
export async function nextMeeting(cfg: Config, now = Date.now()): Promise<Meeting | null> {
  if (!cfg.calendar.enabled || icsUrls(cfg).length === 0) return null;

  const ICAL = await loadIcal();
  if (!ICAL) {
    throw new Error(
      'el calendario está activado pero falta la dependencia opcional `ical.js`. ' +
        'Instálala con `npm install -g ical.js`, o pon "calendar.enabled": false.',
    );
  }

  const feeds = await fetchAll(cfg);
  if (feeds.length === 0) return null;

  const all: Meeting[] = [];
  for (const ics of feeds) {
    try {
      all.push(...parseMeetings(ICAL, ics, cfg, now));
    } catch {
      // Un ICS ilegible no puede llevarse por delante a los que sí se leen, ni
      // dejar el panel sin pintar.
    }
  }
  return mergeMeetings(all)[0] ?? null;
}

/**
 * Junta las reuniones de varias fuentes en una sola lista ordenada.
 *
 * La misma reunión aparece en dos calendarios en cuanto compartes agenda con
 * alguien, así que se descartan los duplicados por hora y título. Se conserva
 * la primera copia, que por el orden de fusión es la del calendario que antes
 * aparece en la config.
 */
export function mergeMeetings(meetings: Meeting[]): Meeting[] {
  const seen = new Set<string>();
  return meetings
    .slice()
    .sort((a, b) => a.startsAt - b.startsAt)
    .filter((m) => {
      const key = `${m.startsAt}|${m.title.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
