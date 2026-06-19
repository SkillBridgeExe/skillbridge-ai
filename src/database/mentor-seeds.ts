export interface MentorSeed {
  email: string;
  fullName: string;
  slug: string;
  avatarUrl: string;
  headline: string;
  company: string;
  shortBio: string;
  bio: string;
  linkedinUrl: string;
  phoneNumber: string;
  domainTags: string[];
  skillCanonicalNames: string[];
  sessionPriceVnd: number;
  sessionDurationMinutes: 30 | 45 | 60 | 90 | 120;
  ratingAverage: number;
  reviewCount: number;
  completedSessions: number;
  hasCredentials?: boolean;
}

export const MENTOR_SEEDS: MentorSeed[] = [
  {
    email: 'mentor@skillbridge.com',
    fullName: 'Nguyễn Minh An',
    slug: 'nguyen-minh-an',
    avatarUrl:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/nguyen-minh-an',
    phoneNumber: '+84912345671',
    headline: 'Senior Frontend Engineer',
    company: 'MoMo',
    shortBio:
      'Giúp frontend engineer làm chủ React, TypeScript và tư duy xây dựng sản phẩm ở quy mô lớn.',
    bio: 'Tôi có hơn 8 năm phát triển sản phẩm web cho fintech và thương mại điện tử. Các buổi mentoring tập trung vào code review, kiến trúc frontend, hiệu năng và lộ trình lên senior bằng những bài toán thực tế.',
    domainTags: ['Technology & Software'],
    skillCanonicalNames: ['react', 'typescript', 'nextjs', 'system_design'],
    sessionPriceVnd: 450000,
    sessionDurationMinutes: 60,
    ratingAverage: 4.9,
    reviewCount: 38,
    completedSessions: 126,
    hasCredentials: true,
  },
  {
    email: 'hoanglong.mentor@skillbridge.com',
    fullName: 'Trần Hoàng Long',
    slug: 'tran-hoang-long',
    avatarUrl:
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/tran-hoang-long',
    phoneNumber: '+84912345672',
    headline: 'Backend Engineering Lead',
    company: 'Tiki',
    shortBio: 'Đồng hành cùng backend developer về API design, database và hệ thống phân tán.',
    bio: 'Tôi xây dựng các nền tảng xử lý đơn hàng và thanh toán có lưu lượng lớn. Tôi phù hợp với mentee muốn cải thiện thiết kế API, PostgreSQL, microservices và kỹ năng system design interview.',
    domainTags: ['Technology & Software'],
    skillCanonicalNames: ['node_js', 'postgresql', 'microservices', 'system_design'],
    sessionPriceVnd: 550000,
    sessionDurationMinutes: 60,
    ratingAverage: 4.8,
    reviewCount: 31,
    completedSessions: 98,
  },
  {
    email: 'thuha.mentor@skillbridge.com',
    fullName: 'Lê Thu Hà',
    slug: 'le-thu-ha',
    avatarUrl:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/le-thu-ha',
    phoneNumber: '+84912345673',
    headline: 'Senior Product Designer',
    company: 'Grab',
    shortBio:
      'Review portfolio, case study và quy trình thiết kế sản phẩm dựa trên insight người dùng.',
    bio: 'Tôi hỗ trợ designer biến một dự án thành case study có lập luận rõ ràng, cân bằng nhu cầu người dùng và mục tiêu kinh doanh. Nội dung mentoring gồm research synthesis, interaction design và portfolio review.',
    domainTags: ['Design & Product'],
    skillCanonicalNames: ['figma', 'ui_ux_design', 'communication', 'critical_thinking'],
    sessionPriceVnd: 400000,
    sessionDurationMinutes: 45,
    ratingAverage: 4.9,
    reviewCount: 27,
    completedSessions: 84,
  },
  {
    email: 'quanghuy.mentor@skillbridge.com',
    fullName: 'Phạm Quang Huy',
    slug: 'pham-quang-huy',
    avatarUrl:
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/pham-quang-huy',
    phoneNumber: '+84912345674',
    headline: 'Senior Data Scientist',
    company: 'Trusting Social',
    shortBio: 'Hướng dẫn xây dựng portfolio data, machine learning pipeline và chuẩn bị phỏng vấn.',
    bio: 'Tôi làm việc với bài toán scoring và machine learning trên dữ liệu thực tế. Mentee sẽ được hướng dẫn cách chọn bài toán, đánh giá mô hình, trình bày insight và chuẩn bị cho vòng phỏng vấn data science.',
    domainTags: ['Data & AI'],
    skillCanonicalNames: ['python', 'machine_learning', 'data_science', 'statistics'],
    sessionPriceVnd: 500000,
    sessionDurationMinutes: 60,
    ratingAverage: 4.7,
    reviewCount: 22,
    completedSessions: 73,
  },
  {
    email: 'ngocmai.mentor@skillbridge.com',
    fullName: 'Võ Ngọc Mai',
    slug: 'vo-ngoc-mai',
    avatarUrl:
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/vo-ngoc-mai',
    phoneNumber: '+84912345675',
    headline: 'DevOps & Platform Engineer',
    company: 'VNG',
    shortBio:
      'Biến kiến thức Docker, Kubernetes và cloud thành năng lực vận hành production thực tế.',
    bio: 'Tôi giúp developer hiểu cách một hệ thống được đóng gói, triển khai và quan sát trên production. Lộ trình phù hợp cho người muốn chuyển sang DevOps hoặc nâng chất lượng CI/CD của đội ngũ.',
    domainTags: ['Cloud & DevOps'],
    skillCanonicalNames: ['docker', 'kubernetes', 'cloud_aws', 'ci_cd'],
    sessionPriceVnd: 480000,
    sessionDurationMinutes: 60,
    ratingAverage: 4.8,
    reviewCount: 19,
    completedSessions: 69,
  },
  {
    email: 'giabao.mentor@skillbridge.com',
    fullName: 'Đỗ Gia Bảo',
    slug: 'do-gia-bao',
    avatarUrl:
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=640&h=640&q=85&fm=webp',
    linkedinUrl: 'https://www.linkedin.com/in/do-gia-bao',
    phoneNumber: '+84912345676',
    headline: 'Mobile Engineering Lead',
    company: 'Zalo',
    shortBio: 'Mentoring kiến trúc mobile, chất lượng ứng dụng và lộ trình phát triển lên senior.',
    bio: 'Tôi có kinh nghiệm phát triển ứng dụng mobile phục vụ hàng triệu người dùng. Các buổi mentoring tập trung vào kiến trúc iOS/Flutter, performance, testing và cách ra quyết định kỹ thuật trong đội sản phẩm.',
    domainTags: ['Mobile Development'],
    skillCanonicalNames: ['swift', 'flutter', 'mobile_testing', 'system_design'],
    sessionPriceVnd: 420000,
    sessionDurationMinutes: 60,
    ratingAverage: 4.6,
    reviewCount: 16,
    completedSessions: 57,
  },
];
