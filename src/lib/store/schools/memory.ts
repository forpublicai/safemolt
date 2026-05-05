import type { StoredSchool } from "@/lib/store-types";
import { schoolProfessorsMap, schoolsMap } from "../_memory-state";

export async function getSchool(id: string) {
  return schoolsMap.get(id) ?? null;
}

export async function getSchoolBySubdomain(subdomain: string) {
  const all = Array.from(schoolsMap.values());
  for (const school of all) {
    if (school.subdomain === subdomain) return school;
  }
  return null;
}

export async function listSchools(status?: 'active' | 'draft' | 'archived') {
  const all = Array.from(schoolsMap.values());
  if (status) return all.filter(s => s.status === status);
  return all;
}

export async function createSchool(school: Omit<StoredSchool, 'createdAt' | 'updatedAt'>) {
  const now = new Date().toISOString();
  const stored: StoredSchool = { ...school, createdAt: now, updatedAt: now };
  schoolsMap.set(school.id, stored);
  return stored;
}

export async function updateSchool(
  id: string,
  updates: Partial<Pick<StoredSchool, 'name' | 'description' | 'status' | 'access' | 'requiredEvaluations' | 'config' | 'themeColor' | 'emoji'>>) {
  const existing = schoolsMap.get(id);
  if (!existing) return false;
  schoolsMap.set(id, { ...existing, ...updates, updatedAt: new Date().toISOString() });
  return true;
}

export async function addSchoolProfessor(schoolId: string, professorId: string) {
  const key = `${schoolId}:${professorId}`;
  schoolProfessorsMap.set(key, {
    schoolId,
    professorId,
    status: 'active',
    hiredAt: new Date().toISOString(),
  });
  return true;
}

export async function removeSchoolProfessor(schoolId: string, professorId: string) {
  const key = `${schoolId}:${professorId}`;
  const existing = schoolProfessorsMap.get(key);
  if (!existing) return false;
  schoolProfessorsMap.set(key, { ...existing, status: 'inactive' });
  return true;
}

export async function getSchoolProfessors(schoolId: string) {
  return Array.from(schoolProfessorsMap.values()).filter(
    sp => sp.schoolId === schoolId && sp.status === 'active'
  );
}

export async function isSchoolProfessor(schoolId: string, professorId: string) {
  const key = `${schoolId}:${professorId}`;
  const sp = schoolProfessorsMap.get(key);
  return sp?.status === 'active' || false;
}
