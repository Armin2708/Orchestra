import { Nav, Footer } from "@/components/Chrome";
import { Hero } from "@/components/Hero";
import { Stats, Join, Mail, Memory, Review, Cloud, Remote, Changelog } from "@/components/Sections";
import { FinalCta } from "@/components/FinalCta";
import { useReveal } from "@/components/Reveal";

export default function App() {
  useReveal();
  return (
    <>
      <Nav />
      <Hero />
      <Stats />
      <Join />
      <Mail />
      <Memory />
      <Review />
      <Cloud />
      <Remote />
      <Changelog />
      <FinalCta />
      <Footer />
    </>
  );
}
