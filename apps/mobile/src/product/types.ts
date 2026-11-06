import type { ContentFormat, ContentStatus, Context } from '@ageniza/contracts';

export type Side = 'agency' | 'client';
export type Client = { id: string; name: string; handle: string; photoUrl?: string | null; archived?: boolean };
export type Person = { id: string; name: string; job: string; role: string; email: string; self?: boolean; owner?: boolean };
export type Asset = { id: string; clientId: string; folderId: string; name: string; kind: 'image' | 'video'; uri?: string; size: number; sample?: boolean; processing?: 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed' };
export type UploadProgress = { name: string; phase: 'preparing' | 'sending' | 'confirming' | 'ready' | 'failed'; completedBytes: number; totalBytes: number };
export type Folder = { id: string; clientId: string; name: string; parentId?: string | null };
export type Task = { id: string; title: string; description?: string | null; assigneeId: string; dueOn: string; status: 'pending' | 'delivered' | 'approved' };
export type Comment = { id: string; body: string; side: Side; name: string; createdAt: string };
export type Post = { id: string; clientId: string; title: string; caption: string; format: ContentFormat; status: ContentStatus; date: string; time: string; ownerId: string; folderId: string; mediaIds: string[]; mediaKinds?: Record<string, 'image' | 'video'>; coverId: string | null; revision: number; tasks: Task[]; comments: Comment[]; priority?: boolean; thumbnailId?: string | null };
export type PostInput = Pick<Post, 'clientId' | 'title' | 'caption' | 'format' | 'date' | 'time' | 'ownerId' | 'folderId' | 'mediaIds' | 'coverId'>;
export type Activity = { id: string; title: string; body: string; postId?: string; read: boolean; at: string };
export type Data = { version: 2; clients: Client[]; posts: Post[]; pendingApprovals?: Post[]; people: Person[]; folders: Folder[]; assets: Asset[]; activities: Activity[]; profile: { name: string; agency: string }; permissions: string[]; readOnly: boolean; onboardingPending?: boolean };
export type Move = 'submit' | 'approve' | 'withdraw-approval' | 'changes' | 'publish' | 'cancel' | 'reschedule' | 'unpublish' | 'approveByAgency';
export interface Repository {
  demo: boolean;
  context?: Context;
  load(from: string, to: string): Promise<Data>;
  detail(clientId: string, id: string): Promise<Post>;
  save(input: PostInput, id?: string, onCreated?: (id: string) => void): Promise<Post>;
  move(post: Post, action: Move, comment?: string, date?: string): Promise<Post>;
  task(post: Post, task: Task, action: 'deliver' | 'approve' | 'return', comment?: string): Promise<Post>;
  addTask(post: Post, input: Omit<Task, 'id' | 'status'>): Promise<Post>;
  updateTask(post: Post, task: Task): Promise<Post>;
  comment(post: Post, body: string): Promise<Post>;
  addClient(name: string): Promise<Client>;
  addFolder(clientId: string, name: string, parentId?: string): Promise<Folder>;
  library(clientId: string): Promise<{ folders: Folder[]; assets: Asset[] }>;
  removeAsset(asset: Asset): Promise<void>;
  upload(clientId: string, folderId: string, file: { uri: string; name: string; mimeType: string; size: number; file?: File }, onProgress?: (progress: UploadProgress) => void): Promise<Asset>;
  assetUrl(clientId: string, postId: string | undefined, assetId: string, variant?: 'original' | 'thumbnail'): Promise<string>;
  profile(name: string): Promise<void>;
  reset?(): Promise<void>;
}
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
