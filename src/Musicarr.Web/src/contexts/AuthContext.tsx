import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../services/api';

interface AuthState {
  token: string | null;
  userId: string | null;
  username: string | null;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = localStorage.getItem('musicarr_token');
    const userId = localStorage.getItem('musicarr_userId');
    const username = localStorage.getItem('musicarr_username');
    return {
      token,
      userId,
      username,
      isAuthenticated: !!token,
    };
  });

  useEffect(() => {
    if (state.token) {
      api.defaults.headers.common['Authorization'] = `******;
      api.defaults.headers.common['X-User-Id'] = state.userId || '';
    }
  }, [state.token, state.userId]);

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const response = await api.post('/api/auth/login', { username, password });
      const { token, userId } = response.data;

      localStorage.setItem('musicarr_token', token);
      localStorage.setItem('musicarr_userId', userId);
      localStorage.setItem('musicarr_username', username);

      api.defaults.headers.common['Authorization'] = `******;
      api.defaults.headers.common['X-User-Id'] = userId;

      setState({ token, userId, username, isAuthenticated: true });
      return true;
    } catch {
      return false;
    }
  };

  const logout = () => {
    localStorage.removeItem('musicarr_token');
    localStorage.removeItem('musicarr_userId');
    localStorage.removeItem('musicarr_username');
    delete api.defaults.headers.common['Authorization'];
    delete api.defaults.headers.common['X-User-Id'];
    setState({ token: null, userId: null, username: null, isAuthenticated: false });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
