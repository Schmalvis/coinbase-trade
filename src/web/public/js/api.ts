// API helper functions for communicating with the backend

export function getAuthHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = localStorage.getItem('cb-dashboard-secret');
  if (secret) h['Authorization'] = 'Bearer ' + secret;
  return h;
}

export async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, { headers: getAuthHeaders() });
  return res.json();
}

export async function postJSON(url: string, body?: any): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export async function putJSON(url: string, body: any): Promise<any> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function deleteJSON(url: string): Promise<any> {
  const res = await fetch(url, { method: 'DELETE', headers: getAuthHeaders() });
  return res.json();
}
