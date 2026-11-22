import { describe, it, expect } from 'vitest';
import { checkSql } from '../src/sqlguard.js';

describe('checkSql', () => {
  it('CREATE PROCEDURE — ok', () => {
    expect(checkSql('CREATE PROCEDURE dbo.x AS SELECT 1').ok).toBe(true);
  });
  it('CREATE OR ALTER PROCEDURE — ok', () => {
    expect(checkSql('CREATE OR ALTER PROCEDURE dbo.x AS BEGIN SELECT 1 END').ok).toBe(true);
  });
  it('ALTER FUNCTION / CREATE VIEW — ok', () => {
    expect(checkSql('ALTER FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN 1 END').ok).toBe(true);
    expect(checkSql('CREATE VIEW dbo.v AS SELECT 1 AS x').ok).toBe(true);
  });
  it('DROP PROCEDURE — ok', () => {
    expect(checkSql('DROP PROCEDURE dbo.x').ok).toBe(true);
  });
  it('трейлинг-; — ok', () => {
    expect(checkSql('CREATE PROCEDURE dbo.x AS SELECT 1;').ok).toBe(true);
  });

  it('DROP TABLE — блок', () => {
    expect(checkSql('DROP TABLE dbo.t').ok).toBe(false);
  });
  it('ALTER TABLE — блок', () => {
    expect(checkSql('ALTER TABLE dbo.t ADD c INT').ok).toBe(false);
  });
  it('TRUNCATE TABLE — блок', () => {
    expect(checkSql('TRUNCATE TABLE dbo.t').ok).toBe(false);
  });
  it('EXEC — блок', () => {
    expect(checkSql('EXEC dbo.x').ok).toBe(false);
  });
  it('SELECT — блок', () => {
    expect(checkSql('SELECT 1').ok).toBe(false);
  });
  it('несколько statements — блок', () => {
    expect(checkSql('CREATE PROCEDURE dbo.x AS SELECT 1; DROP TABLE dbo.t').ok).toBe(false);
  });
  it('пустой — блок', () => {
    expect(checkSql('   ').ok).toBe(false);
  });
});
