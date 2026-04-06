const express = require('express');
const router = express.Router();
const { run, get, all } = require('../models/db');

router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: false, limit: '2mb' }));

function requireAuth(req, res, next){
  try{
    if (req.isAuthenticated && req.isAuthenticated()) return next();
  }catch(_){ }
  return res.redirect('/login');
}

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6);

const QUESTION_BANK = [
  { id: 1, dimension: 'focus', text: 'Puedo sostener la atención en una sola tarea durante bastante tiempo sin distraerme.' },
  { id: 2, dimension: 'focus', text: 'Cuando estudio, me resulta natural entrar en estado de concentración profunda.' },
  { id: 3, dimension: 'focus', text: 'Prefiero bloques sin interrupciones antes que estudiar en fragmentos muy cortos.' },
  { id: 4, dimension: 'focus', text: 'Si tengo una franja libre grande, la aprovecho bien para estudiar en serio.' },

  { id: 5, dimension: 'structure', text: 'Rindo mejor cuando tengo tiempos definidos, pausas claras y una rutina marcada.' },
  { id: 6, dimension: 'structure', text: 'Me ayuda mucho que el estudio tenga pasos concretos y previsibles.' },
  { id: 7, dimension: 'structure', text: 'Sin estructura externa, me cuesta arrancar o sostener el estudio.' },
  { id: 8, dimension: 'structure', text: 'Me funciona dividir el estudio en bloques claramente medidos.' },

  { id: 9, dimension: 'stamina', text: 'Tengo buena energía mental para sesiones largas sin caer demasiado.' },
  { id: 10, dimension: 'stamina', text: 'Puedo volver a concentrarme rápido después de una pausa breve.' },
  { id: 11, dimension: 'stamina', text: 'No me agota demasiado estudiar varios bloques en un mismo día.' },
  { id: 12, dimension: 'stamina', text: 'Mi rendimiento suele sostenerse estable durante una sesión completa.' },

  { id: 13, dimension: 'recall', text: 'Aprendo mejor cuando me obligo a recordar sin mirar apuntes.' },
  { id: 14, dimension: 'recall', text: 'Me sirven mucho las autoevaluaciones, preguntas y repasos activos.' },
  { id: 15, dimension: 'recall', text: 'Explicar con mis palabras me ayuda más que releer muchas veces.' },
  { id: 16, dimension: 'recall', text: 'Valoro técnicas donde tenga que recuperar información desde memoria.' },

  { id: 17, dimension: 'autonomy', text: 'Puedo organizarme solo sin depender tanto de presión externa.' },
  { id: 18, dimension: 'autonomy', text: 'Si sé qué tengo que hacer, normalmente lo hago sin procrastinar demasiado.' },
  { id: 19, dimension: 'autonomy', text: 'Puedo adaptar mi forma de estudio cuando cambia la semana o mis horarios.' },
  { id: 20, dimension: 'autonomy', text: 'Me resulta natural revisar y ajustar mi estrategia de estudio por mi cuenta.' }
];

const METHODS = [
  {
    id: 'pomodoro_estructurado',
    title: 'Pomodoro Estructurado',
    profile: 'Aprendiz Estructurado',
    workMin: 25,
    breakMin: 5,
    weights: { focus: 0.95, structure: 1.45, stamina: 0.90, recall: 0.90, autonomy: 1.00 },
    explanation: 'Tu perfil necesita ritmo claro, bloques cortos y una cadencia muy estable para sostener el estudio sin desgaste.'
  },
  {
    id: 'pomodoro_extendido',
    title: 'Pomodoro Extendido',
    profile: 'Aprendiz de Ritmo Sostenido',
    workMin: 40,
    breakMin: 10,
    weights: { focus: 1.00, structure: 1.20, stamina: 1.30, recall: 0.90, autonomy: 1.00 },
    explanation: 'Tenés estructura y energía suficiente para trabajar en tandas más largas sin perder regularidad.'
  },
  {
    id: 'flujo_profundo_90_20',
    title: 'Flujo Profundo 90/20',
    profile: 'Aprendiz de Flujo Profundo',
    workMin: 90,
    breakMin: 20,
    weights: { focus: 1.55, structure: 0.85, stamina: 1.35, recall: 1.00, autonomy: 1.15 },
    explanation: 'Mostrás alta concentración y buena resistencia mental, así que te convienen bloques largos con pocas interrupciones.'
  },
  {
    id: 'bloques_52_17',
    title: 'Bloques 52/17',
    profile: 'Aprendiz de Sesión Larga',
    workMin: 52,
    breakMin: 17,
    weights: { focus: 1.20, structure: 1.00, stamina: 1.35, recall: 0.95, autonomy: 1.05 },
    explanation: 'Rendís bien cuando combinás intensidad real con pausas visibles y recuperadoras.'
  },
  {
    id: 'active_recall_sprint',
    title: 'Active Recall Sprint',
    profile: 'Aprendiz de Recuperación Activa',
    workMin: 30,
    breakMin: 5,
    weights: { focus: 1.00, structure: 1.05, stamina: 0.95, recall: 1.55, autonomy: 1.00 },
    explanation: 'Tu aprendizaje mejora cuando te exigís recordar, responder y autoevaluarte en ciclos cortos y activos.'
  },
  {
    id: 'spaced_repetition_ciclica',
    title: 'Spaced Repetition Cíclica',
    profile: 'Aprendiz de Repetición Inteligente',
    workMin: 20,
    breakMin: 5,
    weights: { focus: 0.90, structure: 1.15, stamina: 0.90, recall: 1.45, autonomy: 1.10 },
    explanation: 'Te conviene estudiar con repasos frecuentes y distribuidos, cuidando la memoria de largo plazo.'
  },
  {
    id: 'feynman_sintesis',
    title: 'Feynman + Síntesis',
    profile: 'Aprendiz Explicador',
    workMin: 45,
    breakMin: 10,
    weights: { focus: 1.05, structure: 0.95, stamina: 1.00, recall: 1.35, autonomy: 1.25 },
    explanation: 'Aprendés mejor cuando transformás ideas complejas en explicaciones simples hechas por vos.'
  },
  {
    id: 'interleaving_analitico',
    title: 'Interleaving Analítico',
    profile: 'Aprendiz Analítico',
    workMin: 35,
    breakMin: 5,
    weights: { focus: 1.10, structure: 1.00, stamina: 1.00, recall: 1.20, autonomy: 1.20 },
    explanation: 'Tu perfil tolera bien alternar temas y comparar enfoques, algo ideal para materias densas.'
  },
  {
    id: 'focus_matrix_45_15',
    title: 'Focus Matrix 45/15',
    profile: 'Aprendiz de Matriz de Foco',
    workMin: 45,
    breakMin: 15,
    weights: { focus: 1.25, structure: 1.15, stamina: 1.10, recall: 0.95, autonomy: 1.00 },
    explanation: 'Necesitás foco real, pero con una pausa visible que te permita sostener calidad y constancia.'
  },
  {
    id: 'micro_sprints_15_5',
    title: 'Micro-sprints de Arranque 15/5',
    profile: 'Aprendiz de Arranque Progresivo',
    workMin: 15,
    breakMin: 5,
    weights: { focus: 0.80, structure: 1.30, stamina: 0.75, recall: 1.00, autonomy: 0.90 },
    explanation: 'Cuando cuesta arrancar o sostenerte, conviene empezar con mini bloques que bajen la fricción inicial.'
  }
];

const MINDHACK_FINAL_NOTE = 'La IA es tu motor, pero tu cerebro es el conductor. Siempre cierra tu sesión con una acción analógica (escribir o hablar) para consolidar el conocimiento.';

const MINDHACK_PROFILES = {
  D1: {
    id: 'deep_diver',
    name: 'Perfil Deep Diver',
    dominantDimension: 'D1',
    howItWorks: 'Tu cerebro destaca en la atención sostenida. Entras en estado de "flow" fácilmente y los bloques largos de estudio son tu zona de poder.',
    starMethod: 'Inmersión Sintética',
    steps: [
      'Pide a una IA que extraiga los 5 conceptos nucleares de tu material.',
      'Estudia 90 min sin distracciones.',
      'Pide a la IA un Mapa Conceptual del tema y replícalo a mano sin mirar la pantalla para fijar la memoria espacial.'
    ]
  },
  D2: {
    id: 'estructural_atomico',
    name: 'Perfil Estructural-Atómico',
    dominantDimension: 'D2',
    howItWorks: 'Necesitas orden y previsibilidad. Tu rendimiento depende de tener un ritmo claro y objetivos segmentados para evitar el agotamiento.',
    starMethod: 'Micro-Sprints con IA',
    steps: [
      'Pide a la IA que divida tu tema en 4 bloques de 25 min con mini-objetivos.',
      'Tras cada bloque, escucha un resumen en audio (Text-to-Speech) generado por IA.',
      'No avances al siguiente bloque hasta que la IA te haga 3 preguntas rápidas de validación.'
    ]
  },
  D3: {
    id: 'active_retriever',
    name: 'Perfil Active Retriever',
    dominantDimension: 'D3',
    howItWorks: 'Eres un estratega. Sabes que el aprendizaje real ocurre al recuperar información, no al leerla. Tienes una alta capacidad de síntesis verbal.',
    starMethod: 'Lightning Rounds',
    steps: [
      'Pide a la IA que genere 20 Flashcards de alta dificultad sobre el texto.',
      'Haz un simulacro donde la IA te dicte las preguntas y tú respondas en voz alta.',
      'Explícale el tema a la IA "como si fuera un niño" (Método Feynman) y deja que ella critique tus vacíos legales.'
    ]
  },
  D4: {
    id: 'autogestor_adaptativo',
    name: 'Perfil Autogestor Adaptativo',
    dominantDimension: 'D4',
    howItWorks: 'Destacas en funciones ejecutivas. Eres flexible, te organizas solo y buscas la eficiencia máxima en el menor tiempo posible.',
    starMethod: 'Multi-Format Blitz',
    steps: [
      'Convierte tus apuntes en un Guion de Podcast con IA para escucharlo mientras te mueves.',
      'Pide a la IA que genere diapositivas clave; tú solo debes completar los detalles técnicos.',
      'Al final del día, haz una "Auditoría de Errores" con la IA para ajustar tu plan de mañana.'
    ]
  }
};

async function ensureStudySchema(){
  try{ await run(`ALTER TABLE users ADD COLUMN test_completado INTEGER DEFAULT 0`); }catch(_){ }
  try{ await run(`ALTER TABLE users ADD COLUMN metodo_asignado TEXT DEFAULT ''`); }catch(_){ }

  try{
    await run(`
      CREATE TABLE IF NOT EXISTS perfiles_estudio (
        user_id INTEGER PRIMARY KEY,
        indice_focus REAL DEFAULT 0,
        indice_structure REAL DEFAULT 0,
        indice_stamina REAL DEFAULT 0,
        indice_recall REAL DEFAULT 0,
        indice_autonomy REAL DEFAULT 0,
        perfil_label TEXT DEFAULT '',
        metodo_asignado TEXT DEFAULT '',
        mindhack_profile_id TEXT DEFAULT '',
        mindhack_profile_name TEXT DEFAULT '',
        mindhack_profile_json TEXT DEFAULT '{}',
        respuestas_json TEXT DEFAULT '[]',
        disponibilidad_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  }catch(_){ }

  try{ await run(`ALTER TABLE perfiles_estudio ADD COLUMN mindhack_profile_id TEXT DEFAULT ''`); }catch(_){ }
  try{ await run(`ALTER TABLE perfiles_estudio ADD COLUMN mindhack_profile_name TEXT DEFAULT ''`); }catch(_){ }
  try{ await run(`ALTER TABLE perfiles_estudio ADD COLUMN mindhack_profile_json TEXT DEFAULT '{}'`); }catch(_){ }

  try{
    await run(`
      CREATE TABLE IF NOT EXISTS disponibilidad_semanal (
        user_id INTEGER NOT NULL,
        dow INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        ocupado INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, dow, hour),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  }catch(_){ }

  try{ await run(`CREATE INDEX IF NOT EXISTS idx_disponibilidad_user ON disponibilidad_semanal(user_id)`); }catch(_){ }
}

function clamp01to5(v){
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function blankAvailability(){
  const out = {};
  for (let dow = 0; dow < 7; dow++) out[dow] = { allDay: false, hours: [] };
  return out;
}

function normalizeAvailability(input){
  const out = blankAvailability();
  const src = (input && typeof input === 'object') ? input : {};
  for (let dow = 0; dow < 7; dow++){
    const row = src[dow] || src[String(dow)] || {};
    const allDay = !!row.allDay;
    const hours = Array.isArray(row.hours)
      ? Array.from(new Set(row.hours.map(Number).filter(h => HOURS.includes(h)))).sort((a, b) => a - b)
      : [];
    out[dow] = { allDay, hours: allDay ? [...HOURS] : hours };
  }
  return out;
}

function parseAnswers(raw){
  const answers = {};
  const src = (raw && typeof raw === 'object') ? raw : {};
  for (const q of QUESTION_BANK){
    answers[q.id] = clamp01to5(src[q.id] ?? src[String(q.id)]);
  }
  return answers;
}

function scaleDimension(values){
  const sum = values.reduce((acc, n) => acc + Number(n || 0), 0);
  const max = values.length * 5;
  return Math.round((sum / max) * 100);
}

function computeIndices(answers){
  const dims = { focus: [], structure: [], stamina: [], recall: [], autonomy: [] };
  for (const q of QUESTION_BANK){
    dims[q.dimension].push(clamp01to5(answers[q.id]));
  }
  return {
    focus: scaleDimension(dims.focus),
    structure: scaleDimension(dims.structure),
    stamina: scaleDimension(dims.stamina),
    recall: scaleDimension(dims.recall),
    autonomy: scaleDimension(dims.autonomy)
  };
}
function sumMindhackAnswers(answers, ids){
  return ids.reduce((acc, id) => acc + clamp01to5(answers[id]), 0);
}

function computeMindhackDimensions(answers){
  return {
    D1: sumMindhackAnswers(answers, [1, 2, 3, 4, 9]),
    D2: sumMindhackAnswers(answers, [5, 6, 7, 8]),
    D3: sumMindhackAnswers(answers, [13, 14, 15, 16]),
    D4: sumMindhackAnswers(answers, [10, 17, 18, 19, 20])
  };
}

function pickMindhackProfile(dimensions){
  const pairs = [
    { id: 'D1', score: Number(dimensions?.D1 || 0) },
    { id: 'D2', score: Number(dimensions?.D2 || 0) },
    { id: 'D3', score: Number(dimensions?.D3 || 0) },
    { id: 'D4', score: Number(dimensions?.D4 || 0) }
  ];

  const maxScore = Math.max(...pairs.map(x => x.score));
  const tied = pairs.filter(x => x.score === maxScore).map(x => x.id);
  const priority = ['D3', 'D1', 'D4', 'D2'];
  const winner = priority.find(id => tied.includes(id)) || 'D3';
  const profile = MINDHACK_PROFILES[winner] || MINDHACK_PROFILES.D3;

  return {
    profileId: profile.id,
    profileName: profile.name,
    dominantDimension: winner,
    scores: {
      D1: Number(dimensions?.D1 || 0),
      D2: Number(dimensions?.D2 || 0),
      D3: Number(dimensions?.D3 || 0),
      D4: Number(dimensions?.D4 || 0)
    },
    howItWorks: profile.howItWorks,
    starMethod: profile.starMethod,
    steps: Array.isArray(profile.steps) ? [...profile.steps] : [],
    finalNote: MINDHACK_FINAL_NOTE
  };
}
function pickMethod(indices){
  if (indices.focus >= 78 && indices.stamina >= 72 && indices.autonomy >= 60){
    return METHODS.find(m => m.id === 'flujo_profundo_90_20');
  }
  if (indices.structure >= 78 && indices.stamina < 72){
    return METHODS.find(m => m.id === 'pomodoro_estructurado');
  }
  if (indices.recall >= 82 && indices.autonomy >= 60){
    return METHODS.find(m => m.id === 'active_recall_sprint');
  }
  if (indices.structure >= 72 && indices.stamina >= 74){
    return METHODS.find(m => m.id === 'pomodoro_extendido');
  }
  if (indices.autonomy >= 80 && indices.recall >= 70){
    return METHODS.find(m => m.id === 'feynman_sintesis');
  }

  const ranked = METHODS
    .map(method => {
      const score =
        (indices.focus * method.weights.focus) +
        (indices.structure * method.weights.structure) +
        (indices.stamina * method.weights.stamina) +
        (indices.recall * method.weights.recall) +
        (indices.autonomy * method.weights.autonomy);
      return { method, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0].method;
}

function buildWindowsForDay(dayAvailability){
  const occupied = new Set((dayAvailability?.hours || []).map(Number));
  const windows = [];
  let start = null;

  for (let hour = 6; hour <= 24; hour++){
    const isFreeHour = hour < 24 ? !occupied.has(hour) : false;
    if (isFreeHour && start === null){
      start = hour * 60;
      continue;
    }
    if (!isFreeHour && start !== null){
      windows.push({ startMin: start, endMin: hour * 60 });
      start = null;
    }
  }

  return windows.filter(w => w.endMin > w.startMin);
}

function formatHour(min){
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function buildDayPlan(method, dayAvailability){
  const windows = buildWindowsForDay(dayAvailability);
  const entries = [];
  const studyBlocks = [];

  for (const window of windows){
    let cursor = window.startMin;
    while ((cursor + method.workMin) <= window.endMin){
      const studyStart = cursor;
      const studyEnd = cursor + method.workMin;
      entries.push({ type: 'study', startMin: studyStart, endMin: studyEnd, text: `Estudiá de ${formatHour(studyStart)} a ${formatHour(studyEnd)}` });
      studyBlocks.push({ startMin: studyStart, endMin: studyEnd });
      cursor = studyEnd;

      if ((cursor + method.breakMin) <= window.endMin){
        const breakStart = cursor;
        const breakEnd = cursor + method.breakMin;
        entries.push({ type: 'break', startMin: breakStart, endMin: breakEnd, text: `Pausa de ${formatHour(breakStart)} a ${formatHour(breakEnd)}` });
        cursor = breakEnd;
      } else {
        break;
      }
    }
  }

  return { entries, studyBlocks };
}

function monIndexFromDate(date){
  return (date.getDay() + 6) % 7;
}

function buildWeeklyPlan(method, availability, now = new Date()){
  const weekly = [];
  for (let dow = 0; dow < 7; dow++){
    const dayAvailability = availability[dow] || availability[String(dow)] || { allDay: false, hours: [] };
    const plan = buildDayPlan(method, dayAvailability);
    const hourHighlights = Array.from(new Set(plan.studyBlocks.flatMap(block => {
      const out = [];
      for (let hour = Math.floor(block.startMin / 60); hour < Math.ceil(block.endMin / 60); hour++){
        if (HOURS.includes(hour)) out.push(hour);
      }
      return out;
    })));

    weekly.push({
      dow,
      dayName: DAYS[dow],
      dayShort: DAY_SHORT[dow],
      entries: plan.entries,
      studyBlocks: plan.studyBlocks,
      hourHighlights
    });
  }

  const todayIndex = monIndexFromDate(now);
  const tomorrowIndex = (todayIndex + 1) % 7;
  const todayPlan = weekly[todayIndex] || { entries: [], studyBlocks: [] };
  const tomorrowPlan = weekly[tomorrowIndex] || { entries: [], studyBlocks: [] };

  let widgetMessage = 'No tenés bloques sugeridos todavía. Editá tus horarios para generar un cronograma.';
  if (todayPlan.studyBlocks.length){
    widgetMessage = `Hoy ${DAYS[todayIndex]} ${now.toLocaleDateString('es-AR')}, empezás a las ${formatHour(todayPlan.studyBlocks[0].startMin)}, ¡preparate!`;
  }else if (tomorrowPlan.studyBlocks.length){
    widgetMessage = 'Mañana empezás a estudiar, hoy relajate.';
  }

  return {
    weekly,
    todayIndex,
    widgetMessage,
    exampleText: todayPlan.entries.length
      ? todayPlan.entries.map(x => x.type === 'study'
          ? x.text.replace('Estudiá', 'Hoy estudiá')
          : x.text.replace('Pausa', 'pausa')
        ).join(', ')
      : ''
  };
}

function buildNextStudyInfo(schedule, now = new Date()){
  const weekly = Array.isArray(schedule?.weekly) ? schedule.weekly : [];
  const todayIndex = monIndexFromDate(now);
  const nowMin = (now.getHours() * 60) + now.getMinutes();

  for (let offset = 0; offset < 14; offset++){
    const dow = (todayIndex + offset) % 7;
    const day = weekly[dow];
    if (!day || !Array.isArray(day.studyBlocks) || !day.studyBlocks.length) continue;

    for (const block of day.studyBlocks){
      if (!block || !Number.isFinite(block.startMin) || !Number.isFinite(block.endMin)) continue;
      if (offset === 0 && block.endMin <= nowMin) continue;

      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + offset);

      const dayLabel = date.toLocaleDateString('es-AR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      });

      const isNow = offset === 0 && block.startMin <= nowMin && nowMin < block.endMin;
      return {
        dayLabel,
        start: formatHour(block.startMin),
        end: formatHour(block.endMin),
        label: isNow ? `${dayLabel} · AHORA` : `${dayLabel} · ${formatHour(block.startMin)}`,
        isNow
      };
    }
  }

  return null;
}

function buildRecommendationText(method, schedule){
  const weekly = Array.isArray(schedule?.weekly) ? schedule.weekly : [];
  const picks = [];

  for (const day of weekly){
    const blocks = Array.isArray(day?.studyBlocks) ? day.studyBlocks : [];
    for (const block of blocks){
      picks.push(`${day.dayName} ${formatHour(block.startMin)}-${formatHour(block.endMin)}`);
      if (picks.length >= 4) break;
    }
    if (picks.length >= 4) break;
  }

  if (!picks.length){
    return 'Todavía no hay horarios sugeridos. Marcá menos horas ocupadas para que la app pueda proponerte bloques reales de estudio.';
  }

  return `Te conviene estudiar con ${method.title} en intervalos como ${picks.join(', ')}.`;
}

function buildStudyPanelResult(state, now = new Date()){
  const method = METHODS.find(m => m.title === (state.profile?.metodo_asignado || state.user?.metodo_asignado)) || METHODS[0];
  const indices = {
    focus: Number(state.profile?.indice_focus || 0),
    structure: Number(state.profile?.indice_structure || 0),
    stamina: Number(state.profile?.indice_stamina || 0),
    recall: Number(state.profile?.indice_recall || 0),
    autonomy: Number(state.profile?.indice_autonomy || 0)
  };
  const schedule = buildWeeklyPlan(method, state.availability, now);

  let mindhack = null;
  try{ mindhack = JSON.parse(String(state.profile?.mindhack_profile_json || '{}')); }catch(_){ mindhack = null; }
  if (!mindhack || typeof mindhack !== 'object' || !mindhack.profileId){
    mindhack = pickMindhackProfile(computeMindhackDimensions(state.answers || {}));
  }

  return {
    method: {
      id: method.id,
      title: method.title,
      profile: state.profile?.perfil_label || method.profile,
      explanation: method.explanation,
      workMin: method.workMin,
      breakMin: method.breakMin
    },
    indices,
    availability: state.availability,
    schedule,
    nextStudy: buildNextStudyInfo(schedule, now),
    recommendationText: buildRecommendationText(method, schedule),
    mindhack
  };
}

async function getUserId(req){
  const raw = String((req.user && (req.user.id || req.user._id || req.user.email)) || '').trim();
  if (!raw) return 0;
  const row = await get(`SELECT id FROM users WHERE id = ? OR email = ? LIMIT 1`, [raw, raw]);
  return Number(row?.id || 0);
}

async function loadStudyState(userId){
  await ensureStudySchema();
  const user = await get(`SELECT id, name, test_completado, metodo_asignado FROM users WHERE id = ? LIMIT 1`, [userId]);
  const profile = await get(`SELECT * FROM perfiles_estudio WHERE user_id = ? LIMIT 1`, [userId]);
  const rows = await all(`SELECT dow, hour FROM disponibilidad_semanal WHERE user_id = ? AND ocupado = 1 ORDER BY dow, hour`, [userId]);
  const availability = blankAvailability();

  for (const row of rows){
    const dow = Number(row.dow);
    const hour = Number(row.hour);
    if (availability[dow] && HOURS.includes(hour)) availability[dow].hours.push(hour);
  }

  for (let dow = 0; dow < 7; dow++){
    availability[dow].hours = Array.from(new Set(availability[dow].hours)).sort((a, b) => a - b);
    availability[dow].allDay = availability[dow].hours.length === HOURS.length;
  }

  let answers = {};
  try{ answers = JSON.parse(String(profile?.respuestas_json || '{}')); }catch(_){ answers = {}; }

  let jsonAvailability = {};
  try{ jsonAvailability = JSON.parse(String(profile?.disponibilidad_json || '{}')); }catch(_){ jsonAvailability = {}; }

  return {
    user: user || { id: userId, name: 'Usuario', test_completado: 0, metodo_asignado: '' },
    profile: profile || null,
    answers: parseAnswers(answers),
    availability: normalizeAvailability(Object.keys(jsonAvailability).length ? jsonAvailability : availability)
  };
}

router.get('/diagnostico', requireAuth, async (req, res) => {
  return res.redirect('/app/perfil');
});

router.post('/diagnostico', requireAuth, async (req, res) => {
  return res.redirect('/app/perfil');
});

router.get('/resultado', requireAuth, async (req, res) => {
  return res.redirect('/app/perfil');
});

router.get('/api/resumen', requireAuth, async (req, res) => {
  try{
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado' });

    const state = await loadStudyState(userId);
    if (Number(state.user.test_completado || 0) !== 1 || !state.profile){
      return res.json({ ok: true, completed: false, ctaUrl: '/app/perfil' });
    }

    const panel = buildStudyPanelResult(state);

    return res.json({
      ok: true,
      completed: true,
      method: panel.method,
      indices: panel.indices,
      availability: panel.availability,
      schedule: panel.schedule,
      nextStudy: panel.nextStudy,
      recommendationText: panel.recommendationText,
      mindhack: panel.mindhack,
      ctaEditUrl: '/app/perfil',
      ctaViewUrl: '/app/perfil'
    });
  }catch(e){
    console.error('GET /estudio/api/resumen error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo cargar el resumen de estudio' });
  }
});

router.get('/api/panel', requireAuth, async (req, res) => {
  try{
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado' });

    const state = await loadStudyState(userId);
    const completed = Number(state.user.test_completado || 0) === 1 && !!state.profile;

    return res.json({
      ok: true,
      completed,
      questions: QUESTION_BANK,
      answers: state.answers,
      availability: state.availability,
      currentMethod: state.profile?.metodo_asignado || state.user?.metodo_asignado || '',
      result: completed ? buildStudyPanelResult(state) : null
    });
  }catch(e){
    console.error('GET /estudio/api/panel error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo cargar el panel de estudio' });
  }
});

router.post('/api/panel', requireAuth, async (req, res) => {
  try{
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado' });

    await ensureStudySchema();

    let answersJson = {};
    let availabilityJson = {};
    try{ answersJson = JSON.parse(String(req.body.answers_json || '{}')); }catch(_){ answersJson = {}; }
    try{ availabilityJson = JSON.parse(String(req.body.availability_json || '{}')); }catch(_){ availabilityJson = {}; }

    const answers = parseAnswers(answersJson);
    const availability = normalizeAvailability(availabilityJson);
    const indices = computeIndices(answers);
    const method = pickMethod(indices);
    const mindhack = pickMindhackProfile(computeMindhackDimensions(answers));

    await run(`
      INSERT INTO perfiles_estudio (
        user_id, indice_focus, indice_structure, indice_stamina, indice_recall, indice_autonomy,
        perfil_label, metodo_asignado, mindhack_profile_id, mindhack_profile_name, mindhack_profile_json,
        respuestas_json, disponibilidad_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        indice_focus = excluded.indice_focus,
        indice_structure = excluded.indice_structure,
        indice_stamina = excluded.indice_stamina,
        indice_recall = excluded.indice_recall,
        indice_autonomy = excluded.indice_autonomy,
        perfil_label = excluded.perfil_label,
        metodo_asignado = excluded.metodo_asignado,
        mindhack_profile_id = excluded.mindhack_profile_id,
        mindhack_profile_name = excluded.mindhack_profile_name,
        mindhack_profile_json = excluded.mindhack_profile_json,
        respuestas_json = excluded.respuestas_json,
        disponibilidad_json = excluded.disponibilidad_json,
        updated_at = datetime('now')
    `, [
      userId,
      indices.focus,
      indices.structure,
      indices.stamina,
      indices.recall,
      indices.autonomy,
      method.profile,
      method.title,
      mindhack.profileId,
      mindhack.profileName,
      JSON.stringify(mindhack),
      JSON.stringify(answers),
      JSON.stringify(availability)
    ]);

    await run(`UPDATE users SET test_completado = 1, metodo_asignado = ? WHERE id = ?`, [method.title, userId]);

    await run(`DELETE FROM disponibilidad_semanal WHERE user_id = ?`, [userId]);
    for (let dow = 0; dow < 7; dow++){
      const hours = availability[dow]?.hours || [];
      for (const hour of hours){
        await run(`
          INSERT OR REPLACE INTO disponibilidad_semanal (user_id, dow, hour, ocupado, created_at, updated_at)
          VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
        `, [userId, dow, hour]);
      }
    }

    const state = await loadStudyState(userId);
    return res.json({
      ok: true,
      completed: true,
      result: buildStudyPanelResult(state)
    });
  }catch(e){
    console.error('POST /estudio/api/panel error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo guardar el panel de estudio' });
  }
});

router.post('/api/reset', requireAuth, async (req, res) => {
  try{
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'No autenticado' });

    await ensureStudySchema();
    await run(`UPDATE users SET test_completado = 0, metodo_asignado = '' WHERE id = ?`, [userId]);
    await run(`DELETE FROM perfiles_estudio WHERE user_id = ?`, [userId]);
    await run(`DELETE FROM disponibilidad_semanal WHERE user_id = ?`, [userId]);

    return res.json({ ok: true });
  }catch(e){
    console.error('POST /estudio/api/reset error:', e);
    return res.status(500).json({ ok: false, error: 'No se pudo reiniciar el test de estudio' });
  }
});

router.post('/reset', requireAuth, async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.redirect('/login');

  await ensureStudySchema();
  await run(`UPDATE users SET test_completado = 0, metodo_asignado = '' WHERE id = ?`, [userId]);
  await run(`DELETE FROM perfiles_estudio WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM disponibilidad_semanal WHERE user_id = ?`, [userId]);

  return res.redirect('/app/perfil');
});

module.exports = router;