export interface StoredHumanUser {
  id: string;
  cognitoSub: string;
  email: string | null;
  name: string | null;
  dashboardUsername: string | null;
  isUsernameHidden: boolean;
  createdAt: string;
}
