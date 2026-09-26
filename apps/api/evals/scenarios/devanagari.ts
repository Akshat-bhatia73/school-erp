/**
 * The dev seed's names as a Hindi speaker types them, so a Hindi question
 * can name a pupil in Devanagari. The seed draws every name from these
 * lists (scripts/dev-seed.ts), so each seeded pupil has a spelling here.
 */
const NAMES: Readonly<Record<string, string>> = {
  // First names
  Aarav: 'आरव', Vivaan: 'विवान', Aditya: 'आदित्य', Reyansh: 'रेयांश', Kabir: 'कबीर', Arjun: 'अर्जुन',
  Ishaan: 'ईशान', Rudra: 'रुद्र', Devansh: 'देवांश', Yuvraj: 'युवराज', Harsh: 'हर्ष', Nikhil: 'निखिल',
  Rohit: 'रोहित', Siddharth: 'सिद्धार्थ', Manav: 'मानव', Pranav: 'प्रणव', Om: 'ओम', Krish: 'क्रिश',
  Tanmay: 'तन्मय', Aryan: 'आर्यन', Dhruv: 'ध्रुव', Kunal: 'कुणाल', Sarthak: 'सार्थक', Rishabh: 'ऋषभ',
  Naveen: 'नवीन', Parth: 'पार्थ', Shaurya: 'शौर्य', Ayush: 'आयुष', Vedant: 'वेदांत', Gaurav: 'गौरव',
  Ananya: 'अनन्या', Diya: 'दिया', Saanvi: 'सान्वी', Aadhya: 'आध्या', Ira: 'इरा', Myra: 'मायरा',
  Kiara: 'किआरा', Anika: 'अनिका', Riya: 'रिया', Meera: 'मीरा', Sneha: 'स्नेहा', Pooja: 'पूजा',
  Nisha: 'निशा', Shreya: 'श्रेया', Tanvi: 'तन्वी', Aditi: 'अदिति', Kavya: 'काव्या', Isha: 'ईशा',
  Neha: 'नेहा', Priya: 'प्रिया', Radhika: 'राधिका', Swara: 'स्वरा', Mahi: 'माही', Bhavya: 'भव्या',
  Lavanya: 'लावण्या', Sanjana: 'संजना', Trisha: 'तृषा', Vaishnavi: 'वैष्णवी', Yashika: 'याशिका', Rachana: 'रचना',
  // Surnames
  Sharma: 'शर्मा', Verma: 'वर्मा', Gupta: 'गुप्ता', Iyer: 'अय्यर', Nair: 'नायर', Reddy: 'रेड्डी',
  Patel: 'पटेल', Desai: 'देसाई', Joshi: 'जोशी', Kulkarni: 'कुलकर्णी', Chauhan: 'चौहान', Rathore: 'राठौर',
  Bhatt: 'भट्ट', Menon: 'मेनन', Shetty: 'शेट्टी', Kapoor: 'कपूर', Malhotra: 'मल्होत्रा', Bose: 'बोस',
  Chatterjee: 'चटर्जी', Banerjee: 'बनर्जी', Pillai: 'पिल्लई', Rao: 'राव', Saxena: 'सक्सेना', Tiwari: 'तिवारी',
  Mishra: 'मिश्रा', Yadav: 'यादव', Sinha: 'सिन्हा', Ghosh: 'घोष', Deshpande: 'देशपांडे', Agarwal: 'अग्रवाल',
  Bansal: 'बंसल', Khanna: 'खन्ना', Thakur: 'ठाकुर', Pandey: 'पांडे', Naidu: 'नायडू', Dubey: 'दुबे',
}

/** A seeded name in Devanagari, word by word; a word not in the lists stays as it is. */
export function hindiName(name: string): string {
  return name
    .split(' ')
    .map((word) => NAMES[word] ?? word)
    .join(' ')
}
