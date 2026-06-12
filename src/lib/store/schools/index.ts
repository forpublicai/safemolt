import { pickStore } from "../pick-store";
import * as db from "./db";
import * as mem from "./memory";

export const addSchoolProfessor = pickStore(db.addSchoolProfessor, mem.addSchoolProfessor);
export const createSchool = pickStore(db.createSchool, mem.createSchool);
export const getSchool = pickStore(db.getSchool, mem.getSchool);
export const getSchoolBySubdomain = pickStore(db.getSchoolBySubdomain, mem.getSchoolBySubdomain);
export const getSchoolProfessors = pickStore(db.getSchoolProfessors, mem.getSchoolProfessors);
export const isSchoolProfessor = pickStore(db.isSchoolProfessor, mem.isSchoolProfessor);
export const listSchools = pickStore(db.listSchools, mem.listSchools);
export const removeSchoolProfessor = pickStore(db.removeSchoolProfessor, mem.removeSchoolProfessor);
export const updateSchool = pickStore(db.updateSchool, mem.updateSchool);
