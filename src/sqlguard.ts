// SQL-guard: перед execute_sql разрешаем только один statement из
// CREATE/ALTER/DROP PROCEDURE|FUNCTION|VIEW. Цель — не дать агенту изменить
// таблицы (DDL) или выполнить несколько независимых statements за один вызов.
//
// Наивная эвристика, НЕ полноценный SQL-парсер. Ограничение v1: `;` внутри
// тела процедуры трактуется как второй statement и блокируется — агент должен
// писать CREATE/ALTER PROCEDURE одним statement без `;` внутри (в T-SQL это допустимо).
const ALLOWED_RE = /^(CREATE|ALTER|DROP)\s+(OR\s+ALTER\s+)?(PROC(EDURE)?|FUNCTION|VIEW)\b/i;

export interface TSqlGuardResult {
  ok: boolean;
  reason: string | null;
}

export function checkSql(sql: string): TSqlGuardResult {
  const s = sql.trim();
  if (s === '') return { ok: false, reason: 'пустой SQL' };
  const head = s.replace(/;+\s*$/, '').trim();
  if (head.includes(';')) return { ok: false, reason: 'несколько statements (;) — разрешён один' };
  if (!ALLOWED_RE.test(head)) {
    return { ok: false, reason: 'разрешены только CREATE/ALTER/DROP PROCEDURE|FUNCTION|VIEW' };
  }
  return { ok: true, reason: null };
}
