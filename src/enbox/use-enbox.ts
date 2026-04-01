import { useContext } from 'react';
import { EnboxContext } from './EnboxProvider';

export const useEnbox = () => {
  const context = useContext(EnboxContext);
  if (!context) {
    throw new Error('useEnbox must be used within an EnboxProvider');
  }
  return context;
};
