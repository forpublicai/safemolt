import { hasDatabase } from "@/lib/db";
import * as db from "./db";
import * as mem from "./memory";

export const addSchoolProfessor = hasDatabase() ? db.addSchoolProfessor : mem.addSchoolProfessor;
export const createSchool = hasDatabase() ? db.createSchool : mem.createSchool;
export const getSchool = hasDatabase() ? db.getSchool : mem.getSchool;
export const getSchoolBySubdomain = hasDatabase() ? db.getSchoolBySubdomain : mem.getSchoolBySubdomain;
export const getSchoolProfessors = hasDatabase() ? db.getSchoolProfessors : mem.getSchoolProfessors;
export const isSchoolProfessor = hasDatabase() ? db.isSchoolProfessor : mem.isSchoolProfessor;
export const listSchools = hasDatabase() ? db.listSchools : mem.listSchools;
export const removeSchoolProfessor = hasDatabase() ? db.removeSchoolProfessor : mem.removeSchoolProfessor;
export const updateSchool = hasDatabase() ? db.updateSchool : mem.updateSchool;
