**Todo**

1. Desynchronize and slightly accentuate fog animations. 

2. Move bump percepts to percepts dropdown under KB

3. Make the wumpus dungeon panel and resolution panel tabbed. WD gets two new tabs "About" and "How To". Res gets one new tab "Decision Rules". 
    1. "About" A few sections explaining (i) the basics of the wumpus world, (ii) the concept of logical agents, and (iii) the specific choices made in designing the visualization. (iii) will be the longest by far and should focus on all that we had to do to get resolution working in practices and the limitations of those strategies.
    2. "How To" A breif paragraph explaining the automatic and manual modes, a diagram (with all elements) showing the correspondence between elements and tiles, and explanations of each interactive element (i.e., buttons).
    3. "Decision Rules" This one will interact with the visualization itself. When the tab is open, it will show the agent checking down the decision rule list. A red x should appear by each rule until one applies and then a green check is placed by that rule and the associated action is taken. This is a visualization of the automatic agent's decision making process. In manual mode, the tab is grayed out and only resolution is accessible. 
4. Under resolutiom, rename the "input" sections to "Anchoring and Component Separation". Is there a better name for Pure Symbols? 

5. When generating levels, resample any level that puts a breeze or stench percept in 1,1. These levels fail trivially in automatic mode. 

6. Add a ladder to 1,1, in the middle bottom as if resting against the sout wall. 

7. Remove seed from url but keep level number and load dialog. 

8. Brighten inactive tab text.

9. Swap the position of the automatic and manual buttons. Make automatic the default. Do nothing and query nothing until the run or step button is pressed. The first press should infer anything that would have been inferred had the agent just moved into 1,1, from elsewhere. 