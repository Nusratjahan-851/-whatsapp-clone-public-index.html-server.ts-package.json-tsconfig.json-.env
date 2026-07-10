import React from "react";
import { Laptop, Lock } from "lucide-react";

interface IntroScreenProps {
  isDark: boolean;
}

export const IntroScreen: React.FC<IntroScreenProps> = ({ isDark }) => {
  return (
    <div
      className={`flex-1 flex flex-col items-center justify-center p-8 select-none text-center ${
        isDark ? "bg-[#222e35]" : "bg-[#f8f9fa]"
      }`}
    >
      <div className="max-w-md flex flex-col items-center space-y-6">
        {/* Visual Mock Illustration of Phone & Computer */}
        <div
          className={`relative p-8 rounded-full flex items-center justify-center transition-all duration-300 ${
            isDark ? "bg-emerald-950/20 text-[#00a884]/30" : "bg-emerald-50 text-emerald-100"
          }`}
        >
          <Laptop size={110} className={`${isDark ? "text-[#00a884]/40" : "text-[#00a884]/30"}`} />
          <div
            className={`absolute bottom-6 right-6 w-14 h-24 rounded-lg border-4 flex items-center justify-center shadow-lg transition-transform hover:scale-105 ${
              isDark ? "bg-[#2a3942] border-[#00a884]/40 text-[#00a884]" : "bg-white border-[#00a884]/30 text-[#00a884]"
            }`}
          >
            {/* Small screen elements on phone */}
            <div className="w-1.5 h-1.5 rounded-full bg-gray-400 absolute top-2" />
            <div className="w-8 h-1 bg-gray-300 dark:bg-gray-700 rounded absolute bottom-2" />
          </div>
        </div>

        {/* Brand Text */}
        <div className="space-y-2">
          <h1
            className={`text-3xl font-light tracking-tight ${
              isDark ? "text-gray-100" : "text-gray-700"
            }`}
          >
            WhatsApp Web
          </h1>
          <p
            className={`text-sm leading-relaxed ${
              isDark ? "text-gray-400" : "text-gray-500"
            }`}
          >
            Send and receive messages without keeping your phone online. Use WhatsApp on up to 4 linked devices and 1 phone at the same time.
          </p>
        </div>

        <div className="w-full h-[1px] bg-gray-200 dark:bg-gray-800" />

        {/* Feature Tags list */}
        <div className="flex flex-wrap items-center justify-center gap-4 text-xs opacity-60">
          <span>✔️ Real-time Voice</span>
          <span>•</span>
          <span>✔️ Media Sharing</span>
          <span>•</span>
          <span>✔️ Meta AI Chatbot</span>
          <span>•</span>
          <span>✔️ Dark Mode</span>
        </div>
      </div>

      {/* Security Footer */}
      <div
        className={`absolute bottom-10 flex items-center gap-1.5 text-xs opacity-40`}
      >
        <Lock size={12} />
        <span>End-to-end encrypted</span>
      </div>
    </div>
  );
};
