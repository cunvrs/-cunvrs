export const CAREERS = [
  { id: 'flower', name: 'Flower Picker', emoji: '🌸', level: 1, minPay: 100, maxPay: 200, tasks: [{ question: 'Which flower is a rose?', options: ['🌹 Rose', '🌻 Sunflower', '🌷 Tulip'], correct: 0 }] },
  { id: 'cashier', name: 'Cashier', emoji: '🎀', level: 5, minPay: 200, maxPay: 350, tasks: [{ question: 'A customer pays 10 unicoins for a 7-unicoin item. How much change?', options: ['2', '3', '4'], correct: 1 }] },
  { id: 'barista', name: 'Barista', emoji: '☕', level: 10, minPay: 350, maxPay: 500, tasks: [{ question: 'A customer orders a strawberry latte. What do you make?', options: ['🍓 Strawberry Latte', '🍵 Matcha', '☕ Espresso'], correct: 0 }] },
  { id: 'baker', name: 'Baker', emoji: '🧁', level: 15, minPay: 500, maxPay: 700, tasks: [{ question: 'Which ingredient helps a cake rise?', options: ['Baking powder', 'Salt', 'Vanilla'], correct: 0 }] },
  { id: 'fashion', name: 'Fashion Designer', emoji: '👗', level: 25, minPay: 700, maxPay: 950, tasks: [{ question: 'Which outfit matches a coquette theme?', options: ['Leather armor', 'Pink bows and lace', 'Sports uniform'], correct: 1 }] },
  { id: 'jewelry', name: 'Jewelry Designer', emoji: '💎', level: 35, minPay: 950, maxPay: 1200, tasks: [{ question: 'Customer wants silver chain and pink heart. Pick the correct order!', options: ['Gold + star', 'Silver + pink heart', 'Black + moon'], correct: 1 }] },
  { id: 'business', name: 'Business Owner', emoji: '💗', level: 50, minPay: 1200, maxPay: 1600, tasks: [{ question: 'Your shop is low on stock. What should you do?', options: ['Ignore it', 'Restock inventory', 'Close permanently'], correct: 1 }] },
  { id: 'ceo', name: 'CEO', emoji: '👑', level: 75, minPay: 1600, maxPay: 2000, tasks: [{ question: 'Company expenses are increasing. What is the best first step?', options: ['Review the budget', 'Spend more randomly', 'Ignore it'], correct: 0 }] },
];
export const getCareer = id => CAREERS.find(j => j.id === id);
export function careerRank(shifts) {
  return [...[{ shifts: 0, name: 'Trainee', bonus: 0 }, { shifts: 10, name: 'Junior', bonus: .05 }, { shifts: 25, name: 'Experienced', bonus: .10 }, { shifts: 50, name: 'Senior', bonus: .20 }, { shifts: 100, name: 'Manager', bonus: .35 }]].reverse().find(r => shifts >= r.shifts);
}
