
export const CAREERS = [
  {
    id: 'flower',
    name: 'Flower Picker',
    emoji: '🌸',
    level: 1,
    minPay: 150,
    maxPay: 250,
    tasks: [{
      question: 'Which flower is a rose?',
      options: ['🌹 Rose', '🌻 Sunflower', '🌷 Tulip'],
      correct: 0,
    }],
  },
  {
    id: 'cashier',
    name: 'Cashier',
    emoji: '🎀',
    level: 5,
    minPay: 200,
    maxPay: 300,
    tasks: [{
      question: 'A customer pays 10 Unicoins for a 7-Unicoin item. How much change?',
      options: ['2', '3', '4'],
      correct: 1,
    }],
  },
  {
    id: 'barista',
    name: 'Barista',
    emoji: '☕',
    level: 10,
    minPay: 250,
    maxPay: 350,
    tasks: [{
      question: 'A customer orders a strawberry latte. What do you make?',
      options: ['🍓 Strawberry Latte', '🍵 Matcha', '☕ Espresso'],
      correct: 0,
    }],
  },
  {
    id: 'baker',
    name: 'Baker',
    emoji: '🧁',
    level: 15,
    minPay: 300,
    maxPay: 400,
    tasks: [{
      question: 'Which ingredient helps a cake rise?',
      options: ['Baking powder', 'Salt', 'Vanilla'],
      correct: 0,
    }],
  },
  {
    id: 'fashion',
    name: 'Fashion Designer',
    emoji: '👗',
    level: 25,
    minPay: 350,
    maxPay: 450,
    tasks: [{
      question: 'Which outfit matches a coquette theme?',
      options: ['Leather armor', 'Pink bows and lace', 'Sports uniform'],
      correct: 1,
    }],
  },
  {
    id: 'jewelry',
    name: 'Jewelry Designer',
    emoji: '💎',
    level: 35,
    minPay: 400,
    maxPay: 500,
    tasks: [{
      question: 'A customer wants a silver chain with a pink heart. Which order is correct?',
      options: ['Gold + star', 'Silver + pink heart', 'Black + moon'],
      correct: 1,
    }],
  },
  {
    id: 'business',
    name: 'Business Owner',
    emoji: '💗',
    level: 50,
    minPay: 450,
    maxPay: 550,
    tasks: [{
      question: 'Your shop is low on stock. What should you do?',
      options: ['Ignore it', 'Restock inventory', 'Close permanently'],
      correct: 1,
    }],
  },
  {
    id: 'ceo',
    name: 'CEO',
    emoji: '👑',
    level: 75,
    minPay: 500,
    maxPay: 650,
    tasks: [{
      question: 'Company expenses are increasing. What is the best first step?',
      options: ['Review the budget', 'Spend more randomly', 'Ignore it'],
      correct: 0,
    }],
  },
];

export const getCareer = (id) =>
  CAREERS.find((job) => job.id === id);

const CAREER_RANKS = [
  { shifts: 0, name: 'Trainee', bonus: 0 },
  { shifts: 10, name: 'Junior', bonus: 0.05 },
  { shifts: 30, name: 'Experienced', bonus: 0.10 },
  { shifts: 75, name: 'Senior', bonus: 0.20 },
  { shifts: 150, name: 'Manager', bonus: 0.30 },
];

export function careerRank(shifts = 0) {
  return [...CAREER_RANKS]
    .reverse()
    .find((rank) => shifts >= rank.shifts) || CAREER_RANKS[0];
}
