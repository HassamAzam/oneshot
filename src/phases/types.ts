import { projectConfig } from '../lib/config.js';

export interface Ticket {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  notes?: string[];
}

export function GITLAB_PROJECT_URL(): string {
  const c = projectConfig();
  return `https://${c.gitlab.host}/${c.gitlab.project}`;
}
