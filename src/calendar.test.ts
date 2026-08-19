import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, meetingState } from './config.ts';
import { icsUrls, loadIcal, mergeMeetings, nextMeeting, parseMeetings } from './calendar.ts';

const cfg = { ...DEFAULT_CONFIG, calendar: { ...DEFAULT_CONFIG.calendar, enabled: true } };

/**
 * `ical.js` es dependencia opcional: si no está instalada, estas pruebas se
 * saltan en lugar de fallar. Quien no use el calendario no debería tener que
 * instalarla para poder ejecutar la batería.
 */
const ICAL = await loadIcal();
const skip = ICAL ? false : 'dependencia opcional `ical.js` no instalada';

/** Atajo para no repetir el módulo en cada llamada. */
const meetingsToday = (ics: string, c = cfg, now?: number) => parseMeetings(ICAL!, ics, c, now);

/** ICS mínimo con la misma forma que publica Outlook: TZID de Windows + VTIMEZONE. */
function ics(events: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:Romance Standard Time',
    'BEGIN:STANDARD',
    'DTSTART:16011028T030000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010325T020000',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    events,
    'END:VCALENDAR',
  ].join('\r\n');
}

function vevent(fields: Record<string, string>): string {
  return ['BEGIN:VEVENT', ...Object.entries(fields).map(([k, v]) => `${k}:${v}`), 'END:VEVENT'].join('\r\n');
}

/** 2026-08-18 a las 09:00 hora peninsular (CEST, +0200). */
const NOW = Date.parse('2026-08-18T09:00:00+02:00');

test('Calendario: resuelve TZID de Windows con el VTIMEZONE del propio fichero', { skip }, () => {
  // Sin esto haría falta una base de datos de zonas; el error típico es de
  // una hora exacta, que en un aviso de reunión es peor que no avisar.
  const cal = ics(
    vevent({ 'DTSTART;TZID=Romance Standard Time': '20260818T103000', 'DTEND;TZID=Romance Standard Time': '20260818T110000', SUMMARY: 'Comité' }),
  );
  const [m] = meetingsToday(cal, cfg, NOW);
  assert.ok(m, 'debería encontrar la reunión');
  assert.equal(new Date(m!.startsAt).toISOString(), '2026-08-18T08:30:00.000Z', '10:30 CEST son 08:30 UTC');
});

test('Calendario: expande recurrencias (el daily de la mañana es una de ellas)', { skip }, () => {
  const cal = ics(
    vevent({
      'DTSTART;TZID=Romance Standard Time': '20260601T094500',
      'DTEND;TZID=Romance Standard Time': '20260601T100000',
      RRULE: 'FREQ=WEEKLY;UNTIL=20270101T000000Z;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
      SUMMARY: 'Daily',
    }),
  );
  const found = meetingsToday(cal, cfg, NOW);
  assert.equal(found.length, 1, 'la ocurrencia de hoy, martes');
  assert.equal(found[0]!.title, 'Daily');
  assert.equal(new Date(found[0]!.startsAt).toISOString(), '2026-08-18T07:45:00.000Z');
});

test('Calendario: descarta lo que no reclama al operador', { skip }, () => {
  const base = { 'DTSTART;TZID=Romance Standard Time': '20260818T120000', 'DTEND;TZID=Romance Standard Time': '20260818T130000' };
  const cal = ics([
    vevent({ ...base, SUMMARY: 'Libre', TRANSP: 'TRANSPARENT' }),
    vevent({ ...base, SUMMARY: 'Fuera', 'X-MICROSOFT-CDO-BUSYSTATUS': 'OOF' }),
    vevent({ ...base, SUMMARY: 'Disponible', 'X-MICROSOFT-CDO-BUSYSTATUS': 'FREE' }),
    vevent({ 'DTSTART;VALUE=DATE': '20260818', 'DTEND;VALUE=DATE': '20260819', SUMMARY: 'Vacaciones Juan' }),
    vevent({ ...base, SUMMARY: 'Tiempo de concentración' }),
    vevent({ ...base, SUMMARY: 'Reunión de verdad' }),
  ].join('\r\n'));
  const found = meetingsToday(cal, cfg, NOW);
  assert.deepEqual(found.map((m) => m.title), ['Reunión de verdad']);
});

test('Calendario: una reunión ya empezada sigue contando; una terminada no', { skip }, () => {
  const cal = ics([
    vevent({ 'DTSTART;TZID=Romance Standard Time': '20260818T085000', 'DTEND;TZID=Romance Standard Time': '20260818T093000', SUMMARY: 'En curso' }),
    vevent({ 'DTSTART;TZID=Romance Standard Time': '20260818T080000', 'DTEND;TZID=Romance Standard Time': '20260818T083000', SUMMARY: 'Terminada' }),
  ].join('\r\n'));
  assert.deepEqual(meetingsToday(cal, cfg, NOW).map((m) => m.title), ['En curso']);
});

test('Calendario: no mira más allá de hoy', { skip }, () => {
  const cal = ics(
    vevent({ 'DTSTART;TZID=Romance Standard Time': '20260819T090000', 'DTEND;TZID=Romance Standard Time': '20260819T100000', SUMMARY: 'Mañana' }),
  );
  assert.equal(meetingsToday(cal, cfg, NOW).length, 0);
});

test('Calendario: marca las provisionales y las privadas', { skip }, () => {
  const base = { 'DTSTART;TZID=Romance Standard Time': '20260818T140000', 'DTEND;TZID=Romance Standard Time': '20260818T150000' };
  const cal = ics([
    vevent({ ...base, SUMMARY: 'Quizá', 'X-MICROSOFT-CDO-BUSYSTATUS': 'TENTATIVE' }),
    vevent({ ...base, SUMMARY: 'Secreta', CLASS: 'PRIVATE' }),
  ].join('\r\n'));
  const found = meetingsToday(cal, cfg, NOW);
  assert.equal(found.find((m) => m.title === 'Quizá')?.tentative, true);
  assert.equal(found.find((m) => m.title === 'Secreta')?.private, true);
});

test('Calendario: un ICS basura no tumba el render', { skip }, () => {
  assert.throws(() => meetingsToday('esto no es un ics', cfg, NOW));
  // `nextMeeting` envuelve esto en un try/catch: el panel se pinta sin reunión.
});

test('meetingState: escalera de inminencia', () => {
  const m = DEFAULT_CONFIG.calendar.minutes;
  assert.equal(meetingState(180, m), 'inactiva', 'lejos: informa pero no reclama');
  assert.equal(meetingState(90, m), 'activa');
  assert.equal(meetingState(20, m), 'listo');
  assert.equal(meetingState(6, m), 'espera');
  assert.equal(meetingState(2, m), 'permiso');
  assert.equal(meetingState(-10, m), 'permiso', 'ya empezada es lo más urgente que hay');
});

test('Calendarios: `icsUrl` admite una URL suelta o una lista', () => {
  const cfg = (icsUrl: unknown) =>
    ({ ...DEFAULT_CONFIG, calendar: { ...DEFAULT_CONFIG.calendar, icsUrl } }) as never;
  // Una sola URL: lo que ya había, no puede romperse.
  assert.deepEqual(icsUrls(cfg('https://a/x.ics')), ['https://a/x.ics']);
  assert.deepEqual(icsUrls(cfg(['https://a/x.ics', 'https://b/y.ics'])), ['https://a/x.ics', 'https://b/y.ics']);
  // Vacíos y espacios sobrantes fuera: una coma de más en el JSON no debe
  // convertirse en una descarga a la cadena vacía.
  assert.deepEqual(icsUrls(cfg(['  https://a/x.ics  ', '', '   '])), ['https://a/x.ics']);
  assert.deepEqual(icsUrls(cfg('')), []);
  assert.deepEqual(icsUrls(cfg([])), []);
  // Pegar la misma URL dos veces es fácil, y cada copia costaría una descarga
  // entera para producir duplicados que luego habría que descartar.
  assert.deepEqual(icsUrls(cfg(['https://a/x.ics', 'https://a/x.ics', 'https://b/y.ics'])), [
    'https://a/x.ics',
    'https://b/y.ics',
  ]);
});

test('Calendarios: se funden por hora y se quitan los duplicados', () => {
  const m = (title: string, startsAt: number) => ({ title, startsAt, endsAt: startsAt + 1800_000, tentative: false, private: false });
  const merged = mergeMeetings([
    m('Retro', 3000),
    m('Daily', 1000),
    // La misma reunión vista desde dos calendarios compartidos.
    m('Daily', 1000),
    m('Uno a uno', 2000),
  ]);
  assert.deepEqual(
    merged.map((x) => x.title),
    ['Daily', 'Uno a uno', 'Retro'],
  );
});

test('Calendarios: dos reuniones a la misma hora con títulos distintos son dos', () => {
  const m = (title: string, startsAt: number) => ({ title, startsAt, endsAt: startsAt + 1800_000, tentative: false, private: false });
  assert.equal(mergeMeetings([m('Daily', 1000), m('Comité', 1000)]).length, 2);
});

test('Calendarios: sin ninguna URL no se toca la red', async () => {
  const cfg = { ...DEFAULT_CONFIG, calendar: { ...DEFAULT_CONFIG.calendar, enabled: true, icsUrl: [] } } as never;
  assert.equal(await nextMeeting(cfg, Date.now()), null);
});
