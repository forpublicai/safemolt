export interface StoredHumanUser {
  id: string;
  cognitoSub: string;
  email: string | null;
  name: string | null;
  createdAt: string;
}
