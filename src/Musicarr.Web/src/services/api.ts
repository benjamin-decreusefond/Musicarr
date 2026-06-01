import axios from 'axios';

export const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('musicarr_token');
      localStorage.removeItem('musicarr_userId');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);
