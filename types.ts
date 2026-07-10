export type MessageType = "text" | "image" | "voice" | "file" | "video" | "sticker" | "contact" | "location" | "poll";
export type MessageStatus = "sent" | "delivered" | "read";

export interface MessageReaction {
  emoji: string;
  sender: "me" | "them";
}

export interface PollOption {
  id: string;
  text: string;
  votes: string[]; // List of user names/identifiers who voted for this option
}

export interface PollData {
  question: string;
  options: PollOption[];
  multipleAnswers?: boolean;
}

export interface ContactCard {
  name: string;
  phone: string;
  avatar?: string;
  about?: string;
}

export interface LocationData {
  latitude: number;
  longitude: number;
  name: string;
  address?: string;
}

export interface MessageReply {
  messageId: string;
  text: string;
  sender: "me" | "them";
}

export interface Message {
  id: string;
  sender: "me" | "them";
  text: string;
  timestamp: string;
  timestampSecs?: number;
  type: MessageType;
  status: MessageStatus;
  fileName?: string;
  fileSize?: string;
  fileUrl?: string;
  voiceDuration?: string;
  isTranscribing?: boolean;
  transcription?: string;
  reactions?: MessageReaction[];
  pollData?: PollData;
  contactCard?: ContactCard;
  locationData?: LocationData;
  replyTo?: MessageReply;
  isPinned?: boolean;
  isStarred?: boolean;
}

export interface GroupParticipant {
  id: string;
  name: string;
  role: "admin" | "member";
  avatar?: string;
}

export interface Contact {
  id: string;
  name: string;
  avatar: string;
  verified?: boolean;
  isGroup: boolean;
  unreadCount: number;
  about: string;
  status: "online" | "offline" | "typing...";
  phoneNumber?: string;
  
  // Group specific properties
  groupDescription?: string;
  inviteLink?: string;
  onlyAdminsCanSend?: boolean;
  participants?: GroupParticipant[];

  // User actions
  isMuted?: boolean;
  isBlocked?: boolean;
  archive?: boolean;
  isPinned?: boolean;
  isFavorite?: boolean;
  categories?: string[];
  isActiveChat?: boolean;
  conversationTimestamp?: number;
}

export interface Chat {
  contactId: string;
  messages: Message[];
}

export interface UserProfile {
  name: string;
  about: string;
  avatar: string;
  phoneNumber: string;
}
